"""Drive a command on a real pty: wait for each expected text, then type. Test-only.

argv[1] is JSON: {"cmd": [...], "env": {...}, "steps": [[expect, send], ...], "timeout": secs}.
Prints JSON: {"output", "code", "echo", "icanon", "error"}; echo/icanon are the pty's termios
flags after the command exits (False means the program left the terminal in raw/no-echo mode).
"""
import fcntl, json, os, select, struct, subprocess, sys, termios, time

cfg = json.loads(sys.argv[1])
timeout = cfg.get("timeout", 30)
master, slave = os.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 50, 200, 0, 0))
proc = subprocess.Popen(cfg["cmd"], stdin=slave, stdout=slave, stderr=slave, env=cfg["env"], cwd=cfg.get("cwd"), start_new_session=True)
buf = b""
error = None


def pump(wait):
    global buf
    r, _, _ = select.select([master], [], [], wait)
    if r:
        try:
            chunk = os.read(master, 65536)
        except OSError:
            return False
        buf += chunk
        return bool(chunk)
    return False


pos = 0
for expect, send in cfg["steps"]:
    want = expect.encode()
    deadline = time.time() + timeout
    while buf.find(want, pos) < 0:
        if time.time() > deadline or (proc.poll() is not None and not pump(0.2)):
            error = "timed out waiting for: " + expect
            break
        pump(0.1)
    if error:
        break
    pos = buf.find(want, pos) + len(want)
    time.sleep(0.3)  # let readline arm the next question
    os.write(master, send.encode())

deadline = time.time() + timeout
while proc.poll() is None and time.time() < deadline:
    pump(0.1)
if proc.poll() is None:
    proc.kill()
    error = error or "process did not exit"
while pump(0.2):
    pass
lflag = termios.tcgetattr(slave)[3]
print(json.dumps({
    "output": buf.decode("utf-8", "replace"),
    "code": proc.returncode,
    "echo": bool(lflag & termios.ECHO),
    "icanon": bool(lflag & termios.ICANON),
    "error": error,
}))
