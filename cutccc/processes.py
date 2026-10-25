"""Stop only process trees launched and owned by cutccc."""

import os
import subprocess


def stop_process(process):
    if process.poll() is not None:
        return
    if os.name == "nt":
        # A Windows venv python.exe can be a launcher with a Python child.
        # Killing only the launcher leaves its model/GPU process alive.
        subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                       creationflags=subprocess.CREATE_NO_WINDOW, timeout=20)
    else:
        process.terminate()
    try:
        process.wait(timeout=15)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=10)
