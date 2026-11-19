"""Pure absolute native schedules. Missed work fails; no catch-up or first-touch reset."""


class ScheduleMiss(RuntimeError):
    pass


async def wait_deadline(deadline, *, now, sleep, emit, metadata):
    remaining = deadline - now()
    if remaining > 0:
        await sleep(remaining)
    late = now() - deadline
    if late > .035:
        emit({"event": "deadline-miss", "value": {
            **metadata, "plannedMonotonic": deadline, "actualMonotonic": now(),
            "lateMs": late * 1000,
        }})
        raise ScheduleMiss("Native deadline missed; tape stopped")
    return late * 1000


async def tape_events(tape, *, base, clock, now, sleep, emit, state):
    for gesture in tape:
        deadline = base + (gesture["at"] - clock["at"]) / 1000
        metadata = {"id": gesture["id"], "edge": "down",
                    "plannedGuestAt": gesture["at"],
                    "plannedHostWall": clock["wall"] + gesture["at"] - clock["at"]}
        late = await wait_deadline(deadline, now=now, sleep=sleep, emit=emit, metadata=metadata)
        emit({"event": "gesture-send", "value": {**metadata, "lateMs": late,
              "plannedMonotonic": deadline, "actualMonotonic": now()}})
        if gesture["kind"] == "swipe":
            state["held"] = gesture["end"]
            yield {"kind": "swipe", "gesture": gesture}
            await wait_deadline(deadline + gesture["duration"] / 1000, now=now, sleep=sleep,
                                emit=emit, metadata={**metadata, "edge": "up",
                                "plannedGuestAt": gesture["at"] + gesture["duration"],
                                "plannedHostWall": metadata["plannedHostWall"] + gesture["duration"]})
            state["held"] = None
        else:
            state["held"] = gesture["start"]
            yield {"kind": "down", "point": gesture["start"]}
            await wait_deadline(deadline + gesture["duration"] / 1000, now=now, sleep=sleep,
                                emit=emit, metadata={**metadata, "edge": "up",
                                "plannedGuestAt": gesture["at"] + gesture["duration"],
                                "plannedHostWall": metadata["plannedHostWall"] + gesture["duration"]})
            yield {"kind": "up", "point": gesture["end"]}
            state["held"] = None


async def observe_foreground(read, *, start, stop, now, sleep, emit, samples):
    deadline = start
    previous_read_finished = float("-inf")
    missed = False
    while deadline <= stop:
        remaining = deadline - now()
        if remaining > 0:
            await sleep(remaining)
        actual = now()
        if deadline <= previous_read_finished or actual - deadline > 1:
            emit({"event": "sample-deadline-miss", "value": {
                "plannedMonotonic": deadline, "actualMonotonic": actual,
                "lateMs": (actual - deadline) * 1000,
            }})
            missed = True
        else:
            try:
                value = await read()
            except TimeoutError:
                emit({"event": "sample-timeout", "value": {"plannedMonotonic": deadline}})
                missed = True
            else:
                samples.append(value)
                emit({"event": "foreground", "value": value})
            previous_read_finished = now()
        deadline += 1
    # A gap still invalidates the run. Preserve any later evidence and never replay HID.
    return "Foreground deadline missed; no catch-up reads" if missed else None


async def release_held(state, send, emit, wall_now):
    if state["held"] is not None:
        emit({"event": "cleanup-release", "value": {"point": state["held"],
              "wall": wall_now(), "qualification": "cleanup, not tape replay"}})
        await send(state["held"])
        state["held"] = None


async def send_native_tape(send, release):
    """Report an input failure after releasing held input so foreground reads can finish."""
    try:
        try:
            await send()
        finally:
            await release()
    except Exception as error:
        return str(error)
    return None
