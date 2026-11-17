"""Pure absolute native schedules. Missed work fails; no catch-up or first-touch reset."""


class ScheduleMiss(RuntimeError):
    pass


async def wait_deadline(deadline, *, now, sleep, emit, metadata, allowance=.035):
    remaining = deadline - now()
    if remaining > 0:
        await sleep(remaining)
    late = now() - deadline
    if late > allowance:
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


async def sample_events(read, *, start, stop, now, sleep, emit):
    deadline = start
    while deadline <= stop:
        await wait_deadline(deadline, now=now, sleep=sleep, emit=emit,
                            metadata={"role": "foreground"}, allowance=1)
        yield await read()
        deadline += 1
        if deadline <= stop and now() >= deadline:
            emit({"event": "sample-deadline-miss", "value": {
                "plannedMonotonic": deadline, "actualMonotonic": now(),
                "lateMs": (now() - deadline) * 1000,
            }})
            raise ScheduleMiss("Foreground deadline missed; no catch-up reads")


async def release_held(state, send, emit, wall_now):
    if state["held"] is not None:
        emit({"event": "cleanup-release", "value": {"point": state["held"],
              "wall": wall_now(), "qualification": "cleanup, not tape replay"}})
        await send(state["held"])
        state["held"] = None
