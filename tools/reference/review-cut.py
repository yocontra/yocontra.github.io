"""Make a 90-second review cut of a completed saloon capture at its original playback speed."""

import json
import subprocess
import sys
from pathlib import Path


# Name, waypoint, seconds relative to arrival, length. Both revisions use the same edit.
SHOTS = (
    ("Street", "street", -5, 10),
    ("Enter", "threshold", -4, 10),
    ("Bar", "bar", 0, 8),
    ("First person", "first-person-combat", 0, 18),
    ("Stairs", "stairs", -6, 14),
    ("Third person", "third-person-combat", 0, 18),
    ("Exit", "outside", -12, 12),
)


def make_cut(directory: Path) -> None:
    capture = json.loads((directory / "capture.json").read_text())
    if not capture["completed"] or capture["group"] not in ("noon", "dusk", "night"):
        raise ValueError("Expected a completed saloon recording")
    receipt = capture["samples"][0]
    source = directory / "saloon.webm"
    packets = subprocess.check_output(
        ["ffprobe", "-v", "error", "-select_streams", "a", "-show_entries",
         "packet=pts_time", "-of", "csv=p=0", str(source)],
        text=True,
    )
    end = float(packets.splitlines()[-1])
    # Earlier receipts did not store the lead-in between recording and the first input.
    offset = receipt.get("pilotOffset", end - receipt["samples"][-1]["seconds"])
    cuts = []
    filters = []
    for index, (name, waypoint, shift, length) in enumerate(SHOTS):
        arrival = next(s["seconds"] for s in receipt["samples"] if s["name"] == waypoint)
        start = round(max(0, min(end - length, arrival + offset + shift)), 3)
        cuts.append({"shot": name, "sourceStart": start, "duration": length})
        # Fill display intervals between source frames. Preserve the timing of the recorded sound.
        filters.extend([
            f"[0:v]fps=30,tpad=stop_mode=clone:stop_duration=90,"
            f"trim=start={start}:duration={length},setpts=PTS-STARTPTS,"
            f"pad=ceil(iw/2)*2:ceil(ih/2)*2[v{index}]",
            f"[0:a]atrim=start={start}:duration={length},asetpts=PTS-STARTPTS[a{index}]",
        ])
    streams = "".join(f"[v{i}][a{i}]" for i in range(len(cuts)))
    filters.append(f"{streams}concat=n={len(cuts)}:v=1:a=1[v][a]")
    subprocess.run(
        ["ffmpeg", "-loglevel", "error", "-i", str(source), "-filter_complex",
         ";".join(filters), "-map", "[v]", "-map", "[a]", "-c:v", "libx264", "-crf", "20",
         "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart", "-threads", "2",
         "-y", str(directory / "review-90s.mp4")],
        check=True,
    )
    (directory / "review-90s.json").write_text(json.dumps({"edits": cuts}, indent=2) + "\n")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("Expected the directory containing capture.json and saloon.webm")
    make_cut(Path(sys.argv[1]))
