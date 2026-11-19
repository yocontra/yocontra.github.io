"""Offline fake-clock tests: imports only the pure schedule, never fb-idb/device APIs."""
import asyncio
import sys
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools" / "content"))
from simulator_schedule import ScheduleMiss, tape_events, observe_foreground, release_held


class Clock:
    def __init__(self, overshoot=0):
        self.value, self.overshoot = 0, overshoot

    def now(self):
        return self.value

    async def sleep(self, seconds):
        self.value += seconds + self.overshoot


def plan():
    return [{"id": i, "at": 1000 + i * 1000, "duration": 100,
             "kind": "tap", "start": {"x": 1, "y": 2}, "end": {"x": 1, "y": 2}}
            for i in range(3)]


class ScheduleTests(unittest.IsolatedAsyncioTestCase):
    def sender(self, clock, logs, state):
        return tape_events(plan(), base=0, clock={"at": 0, "wall": 1000},
                           now=clock.now, sleep=clock.sleep, emit=logs.append, state=state)

    async def test_multi_deadline_pause_never_replays_an_onset(self):
        clock, logs, state = Clock(overshoot=8), [], {"held": None}
        events = self.sender(clock, logs, state)
        with self.assertRaises(ScheduleMiss):
            await anext(events)
        self.assertEqual(logs[-1]["event"], "deadline-miss")
        self.assertEqual(logs[-1]["value"]["id"], 0)
        self.assertGreater(logs[-1]["value"]["lateMs"], 35)
        self.assertIsNone(state["held"])
        self.assertFalse(any(row["event"] == "gesture-send" for row in logs))

    async def test_expired_release_is_cleanup_only_and_no_later_gesture_runs(self):
        clock, logs, state = Clock(), [], {"held": None}
        events = self.sender(clock, logs, state)
        self.assertEqual((await anext(events))["kind"], "down")
        clock.value += 5
        with self.assertRaises(ScheduleMiss):
            await anext(events)
        released = []
        async def send(point):
            released.append(point)
        await release_held(state, send, logs.append, clock.now)
        self.assertEqual(len(released), 1)
        self.assertEqual(logs[-1]["event"], "cleanup-release")
        self.assertIsNone(state["held"])
        self.assertEqual([row["value"]["id"] for row in logs
                          if row["event"] == "gesture-send"], [0])

    async def test_normal_schedule_and_unchanged_35ms_allowance(self):
        clock, logs, state = Clock(), [], {"held": None}
        self.assertEqual([event["kind"] async for event in self.sender(clock, logs, state)],
                         ["down", "up"] * 3)
        late = self.sender(Clock(.036), [], {"held": None})
        with self.assertRaises(ScheduleMiss):
            await anext(late)

    async def test_sampler_does_not_burst_after_a_stalled_read(self):
        clock, logs, reads, samples = Clock(), [], [], []
        async def read():
            reads.append(clock.now())
            if len(reads) == 1:
                clock.value += 4
            return {"wall": clock.now()}
        failure = await observe_foreground(read, start=0, stop=7, now=clock.now,
                                           sleep=clock.sleep, emit=logs.append, samples=samples)
        self.assertIn("Foreground deadline missed", failure)
        self.assertEqual(reads, [0, 5, 6, 7])
        self.assertEqual(samples, [{"wall": time} for time in (4, 5, 6, 7)])
        self.assertEqual([row["value"]["plannedMonotonic"] for row in logs
                          if row["event"] == "sample-deadline-miss"], [1, 2, 3, 4])

    async def test_stalled_foreground_is_reported_without_canceling_input(self):
        clock, logs, samples = Clock(), [], []
        allow_touch = asyncio.Event()

        async def read():
            if clock.value == 0:
                allow_touch.set()
                raise TimeoutError()
            return {"wall": clock.now()}

        async def send():
            await allow_touch.wait()
            return [event["kind"] async for event in self.sender(Clock(), [], {"held": None})]

        failure, gestures = await asyncio.gather(
            observe_foreground(read, start=0, stop=2, now=clock.now,
                               sleep=clock.sleep, emit=logs.append, samples=samples),
            send(),
        )
        self.assertIn("Foreground deadline missed", failure)
        self.assertEqual(logs[0]["event"], "sample-timeout")
        self.assertEqual(samples, [{"wall": 1}, {"wall": 2}])
        self.assertEqual(gestures, ["down", "up"] * 3)


if __name__ == "__main__":
    unittest.main()
