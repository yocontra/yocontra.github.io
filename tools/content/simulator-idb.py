"""One supported fb-idb client/channel. JSON-lines RPC; no device effects on import."""
import argparse
import asyncio
import hashlib
import inspect
import json
import logging
import math
import time
from pathlib import Path

from simulator_schedule import foreground_schedule, tape_events, observe_foreground, release_held, send_native_tape
from idb.grpc.client import Client
from idb.common.types import (
    AccessibilityBackend, AccessibilityInfoOptions, AccessibilityOutputFormat, AccessibilityPoint,
    HIDDirection, HIDOrientationType, HIDPress, HIDSwipe, HIDTouch, Point, TCPAddress,
)


# Command corrections in milliseconds from trusted portrait and landscape Safari samples.
# The intervals are native screen points. Other path lengths retain the default swipe.
# For the 146-point portrait move, 44 ms centers the native release within the guest window.
SWIPE_CALIBRATION = {
    "move": ((144, 148, 44), (57, 61, 35)),
    "look": ((36, 40, 24), (79, 83, 42)),
}


def emit(value):
    print(json.dumps({**value, "hostWall": time.time() * 1000}, default=str), flush=True)


def api_metadata():
    paths = {inspect.getfile(Client), inspect.getfile(HIDPress)}
    return {"python": __import__("sys").version, "methods": {
        name: str(inspect.signature(getattr(Client, name)))
        for name in ("build", "hid", "accessibility_info", "set_orientation", "get_orientation", "list_apps", "launch")
    }, "sources": {p: hashlib.sha256(Path(p).read_bytes()).hexdigest() for p in paths}}


async def ax(client, keys=None, target=None):
    result = await client.accessibility_info(target, AccessibilityInfoOptions(
        backend=AccessibilityBackend.AXBRIDGE_PERSISTENT,
        format=AccessibilityOutputFormat.COMPLETE, keys=keys,
    ))
    return json.loads(result.json)


def applications(value):
    if isinstance(value, list):
        return [item for child in value for item in applications(child)]
    if not isinstance(value, dict):
        return []
    keys = ("AXRole", "role", "type", "bundleIdentifier", "bundle_id", "bundleID", "pid", "processIdentifier", "process_id")
    own = [{k: value[k] for k in keys if k in value}] if value.get("AXRole", value.get("role", value.get("type"))) in ("Application", "AXApplication") else []
    return own + [item for child in value.values() for item in applications(child)]


async def native_apps(client):
    return [{"bundle_id": app.bundle_id, "process_id": app.process_id,
             "process_state": app.process_state.name}
            for app in await client.list_apps(fetch_process_state=True)]


def foreground_ax(value):
    # Keep native provenance; do not synthesize a bundle field in AX records.
    return {"target": value.get("target"), "backend": value.get("backend"),
            "elements": applications(value)}


async def record(client, request, udid):
    """Keep failed foreground evidence separate from the HID schedule."""
    clock, tape = request["clock"], request["tape"]
    loop = asyncio.get_running_loop()
    base = loop.time() + (clock["wall"] - time.time() * 1000) / 1000
    foreground, state = [], {"held": None}
    foreground_plan = list(foreground_schedule(tape, clock["at"]))
    foreground_deadlines = [base + (at - clock["at"]) / 1000 for at in foreground_plan]
    emit({"event": "foreground-plan", "value": {"guestAt": foreground_plan,
                                                 "monotonic": foreground_deadlines}})

    async def read_foreground():
        started = time.time() * 1000
        elapsed = {}

        async def timed(name, read):
            begin = loop.time()
            try:
                return await read()
            finally:
                elapsed[name] = (loop.time() - begin) * 1000

        # Read only identity fields. The full AX tree is reserved for coordinate
        # calibration, where we also need bounds and interaction metadata.
        # Bound one probe so it cannot stop foreground sampling for the rest of the tape.
        async with asyncio.timeout(1.0), asyncio.TaskGroup() as reads:
            identity = reads.create_task(timed("ax", lambda: ax(client, keys=[
                "type", "pid", "bundleIdentifier",
            ])))
            apps = reads.create_task(timed("apps", lambda: native_apps(client)))
            orientation = reads.create_task(timed("orientation", client.get_orientation))
        return {"startedWall": started, "ax": foreground_ax(identity.result()),
                "apps": apps.result(), "companionUDID": udid,
                "orientation": orientation.result().name,
                "rpcMilliseconds": elapsed, "wall": time.time() * 1000}

    async def events():
        async for event in tape_events(tape, base=base, clock=clock, now=loop.time,
                                       sleep=asyncio.sleep, emit=emit, state=state):
            if event["kind"] == "swipe":
                g = event["gesture"]
                start = Point(**g["start"])
                end = Point(**g["end"])
                distance = math.hypot(end.x - start.x, end.y - start.y)
                correction = next(
                    (ms for minimum, maximum, ms in SWIPE_CALIBRATION.get(g["role"], ())
                     if minimum <= distance <= maximum),
                    0,
                )
                step = 18 if correction else 5
                duration = g["duration"] - correction
                emit({"event": "native-swipe", "value": {"id": g["id"],
                      "step": step, "distance": distance, "commandMilliseconds": duration}})
                yield HIDSwipe(start=start, end=end, delta=step, duration=duration / 1000)
            else:
                yield HIDPress(action=HIDTouch(point=Point(**event["point"])),
                               direction=HIDDirection.DOWN if event["kind"] == "down" else HIDDirection.UP)

    async def send_release(point):
        await client.send_events([HIDPress(action=HIDTouch(point=Point(**point)),
                                           direction=HIDDirection.UP)])

    async def release():
        await asyncio.wait_for(release_held(state, send_release, emit,
                                           lambda: time.time() * 1000), 2)

    tasks = [
        asyncio.create_task(observe_foreground(
            read_foreground, deadlines=foreground_deadlines, now=loop.time,
            sleep=asyncio.sleep, emit=emit, samples=foreground,
        )),
        asyncio.create_task(send_native_tape(lambda: client.hid(events()), release)),
    ]
    try:
        foreground_failure, input_failure = await asyncio.gather(*tasks)
        return {"foreground": foreground, "foregroundFailure": foreground_failure,
                "inputFailure": input_failure, "onePersistentClient": True}
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)


async def run(args):
    async with Client.build(TCPAddress(host="127.0.0.1", port=args.port),
                            logging.getLogger("out-west-recorder")) as client:
        description = await client.describe(fetch_diagnostics=False)
        if description.udid != args.udid:
            raise RuntimeError("Connected companion UDID does not match owned device")
        emit({"event": "connected", "udid": description.udid, "api": api_metadata()})
        while line := await asyncio.to_thread(__import__("sys").stdin.readline):
            command = json.loads(line)
            try:
                name = command["op"]
                if name == "get-orientation":
                    result = (await client.get_orientation()).name
                elif name == "ax":
                    result = await ax(client, keys=command.get("keys"))
                elif name == "hit":
                    result = await ax(client, keys=command.get("keys"),
                                      target=AccessibilityPoint(x=command["x"], y=command["y"]))
                elif name == "apps":
                    result = await native_apps(client)
                elif name == "launch-safari":
                    result = await client.launch(
                        bundle_id="com.apple.mobilesafari", env={},
                        foreground_if_running=True, wait_for_debugger=False, stop=None,
                    )
                elif name == "orientation":
                    selected = HIDOrientationType[command["value"]]
                    await client.set_orientation(selected)
                    result = (await client.get_orientation()).name
                elif name == "tap":
                    await client.tap(command["x"], command["y"], duration=.15)
                    result = True
                elif name == "screenshot":
                    Path(command["path"]).write_bytes(await client.screenshot())
                    result = True
                elif name == "record":
                    result = await record(client, command, args.udid)
                elif name == "close":
                    emit({"id": command["id"], "result": True})
                    break
                else:
                    raise ValueError("Unknown owned native operation")
                emit({"id": command["id"], "result": result})
            except Exception as error:
                emit({"id": command["id"], "error": str(error) or type(error).__name__})


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--inspect-api", action="store_true")
    parser.add_argument("--port", type=int)
    parser.add_argument("--udid")
    args = parser.parse_args()
    if args.inspect_api:
        emit(api_metadata())
    else:
        if not args.port or not args.udid:
            parser.error("Owned port and UDID are required")
        asyncio.run(run(args))
