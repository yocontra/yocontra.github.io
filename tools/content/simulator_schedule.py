"""Pure absolute native schedules. Missed work fails; no catch-up or first-touch reset."""
import asyncio


RECORDING_SECONDS = 60
FOREGROUND_RPC_LIMIT_SECONDS = 1.0
# The release's Python cancellation handoff took at most 6.8 ms in 19 timeouts.
FOREGROUND_HANDOFF_SECONDS = .025


class ScheduleMiss(RuntimeError):
    pass


async def wait_deadline(deadline, *, now, sleep, emit, metadata):
    remaining = deadline - now()
    if remaining > 0:
        await sleep(remaining)
    actual = now()
    late = actual - deadline
    witness = {**metadata, "plannedMonotonic": deadline, "actualMonotonic": actual,
               "lateMs": late * 1000}
    if late > .035:
        emit({"event": "deadline-miss", "value": witness})
        raise ScheduleMiss("Native deadline missed; tape stopped")
    return witness


async def tape_events(tape, *, base, clock, now, sleep, emit, state):
    for gesture in tape:
        deadline = base + (gesture["at"] - clock["at"]) / 1000
        metadata = {"id": gesture["id"], "edge": "down",
                    "plannedGuestAt": gesture["at"],
                    "plannedHostWall": clock["wall"] + gesture["at"] - clock["at"]}
        down = await wait_deadline(deadline, now=now, sleep=sleep, emit=emit, metadata=metadata)
        emit({"event": "gesture-send", "value": down})
        swipe = gesture["kind"] == "swipe"
        if swipe:
            state["held"] = gesture["end"]
            yield {"kind": "swipe", "gesture": gesture}
        else:
            state["held"] = gesture["start"]
            yield {"kind": "down", "point": gesture["start"]}
        duration = gesture["duration"]
        up = await wait_deadline(deadline + duration / 1000, now=now, sleep=sleep, emit=emit,
                                 metadata={**metadata, "edge": "up",
                                 "plannedGuestAt": metadata["plannedGuestAt"] + duration,
                                 "plannedHostWall": metadata["plannedHostWall"] + duration})
        if not swipe:
            # This is host scheduler handoff. The SDK emits a swipe's release internally.
            emit({"event": "gesture-release-send", "value": up})
            yield {"kind": "up", "point": gesture["end"]}
        state["held"] = None


def foreground_schedule(tape, guest_start):
    """One probe per recording second, phased around the unchanged HID tape."""
    # The 5101cb61 stress receipt measured 152 ms p95 for the AX read.
    # Give AX 165 ms before an edge, and input 70 ms after it. These are
    # scheduling estimates only; foreground and gesture acceptance stay independent.
    before_edge_ms, after_edge_ms = 165, 70
    edges = [gesture["at"] + offset for gesture in tape for offset in (0, gesture["duration"])]
    for second in range(RECORDING_SECONDS):
        earliest = guest_start + second * 1000
        nominal = earliest + 200
        latest = earliest + 400
        windows = [(edge - before_edge_ms, edge + after_edge_ms) for edge in edges
                   if earliest - after_edge_ms <= edge <= latest + before_edge_ms]
        candidates = [nominal]
        for start, end in windows:
            candidates.extend((start - 1, end + 1))
        yield min(
            (at for at in candidates if earliest <= at <= latest
             and all(not start <= at <= end for start, end in windows)),
            key=lambda at: (abs(at - nominal), at),
            default=nominal,
        )


async def observe_foreground(read, *, deadlines, now, sleep, emit, samples):
    previous_read_finished = float("-inf")
    missed = False
    failed = False
    for index, deadline in enumerate(deadlines):
        remaining = deadline - now()
        if remaining > 0:
            await sleep(remaining)
        actual = now()
        metadata = {"plannedMonotonic": deadline, "actualMonotonic": actual}
        if deadline <= previous_read_finished or actual - deadline > 1:
            emit({"event": "sample-deadline-miss", "value": {
                **metadata, "lateMs": (actual - deadline) * 1000,
            }})
            missed = True
            continue
        expires = actual + FOREGROUND_RPC_LIMIT_SECONDS
        if index + 1 < len(deadlines):
            expires = min(expires, deadlines[index + 1] - FOREGROUND_HANDOFF_SECONDS)
        rpc = {}
        try:
            if actual >= expires:
                raise TimeoutError()
            value = await read(expires, rpc)
            if now() >= expires:
                raise TimeoutError()
        except TimeoutError:
            emit({"event": "sample-timeout", "value": {
                **metadata, "deadlineMonotonic": expires, "finishedMonotonic": now(), "rpc": rpc,
            }})
            missed = True
        except Exception as error:
            # TaskGroup wraps native RPC errors. Keep that history without canceling HID.
            emit({"event": "sample-error", "value": {**metadata, "error": repr(error)}})
            failed = True
        else:
            samples.append(value)
            emit({"event": "foreground", "value": value, **metadata})
        previous_read_finished = now()
    failures = []
    if missed:
        failures.append("Foreground deadline missed; no catch-up reads")
    if failed:
        failures.append("Foreground native probe failed; see sample-error")
    return " | ".join(failures) or None

async def release_held(state, send, emit, wall_now):
    if state["held"] is not None:
        emit({"event": "cleanup-release", "value": {"point": state["held"],
              "wall": wall_now(), "qualification": "cleanup, not tape replay"}})
        await send(state["held"])
        state["held"] = None


async def send_native_tape(send, release, *, deadline):
    """Bound the whole native input stream, including the final SDK acknowledgement."""
    failures = []
    timeout = asyncio.timeout_at(deadline)
    try:
        async with timeout:
            await send()
    except Exception as error:
        failures.append(
            "Native HID stream did not complete by the recording deadline"
            if timeout.expired() else str(error) or type(error).__name__
        )
    finally:
        try:
            await release()
        except Exception as error:
            failures.append(f"Native held input release failed: {str(error) or type(error).__name__}")
    return " | ".join(failures) or None
