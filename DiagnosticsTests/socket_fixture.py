"""Credential-free Darwin IPC tests. Never starts a tunnel or contacts the network."""
import os
import socket
import subprocess
import sys
import tempfile
import threading
import time

binary = os.path.abspath(sys.argv[1])
passed = 0


def run_case(name, payload=b'{"ok":true}\n', expectation='failure', mode=0o600,
             folder_mode=0o700, symlink=False, regular=False, delay=0, hold_open=0):
    global passed
    # Short path respects macOS's 104-byte sockaddr_un boundary.
    with tempfile.TemporaryDirectory(prefix='sdipc-', dir='/tmp') as directory:
        os.chmod(directory, folder_mode)
        path = os.path.join(directory, 'native.sock')
        server = None
        errors = []
        if regular:
            open(path, 'w').close()
            os.chmod(path, 0o600)
        else:
            server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            target = os.path.join(directory, 'actual.sock') if symlink else path
            server.bind(target)
            os.chmod(target, mode)
            if symlink:
                os.symlink(target, path)
            server.listen(1)
            server.settimeout(7)

            def serve():
                try:
                    connection, _ = server.accept()
                    with connection:
                        request = b''
                        while b'\n' not in request:
                            part = connection.recv(1024)
                            if not part:
                                return
                            request += part
                        if request != b'{"probe":true}\n':
                            errors.append('unexpected request bytes')
                        if delay:
                            time.sleep(delay)
                        if payload:
                            connection.sendall(payload)
                        if hold_open:
                            time.sleep(hold_open)
                except (TimeoutError, BrokenPipeError, ConnectionResetError, OSError):
                    pass

            thread = threading.Thread(target=serve, daemon=True)
            thread.start()
        started = time.monotonic()
        result = subprocess.run([binary, '--socket-probe', directory, expectation],
                                capture_output=True, text=True, timeout=8)
        elapsed = time.monotonic() - started
        if server:
            server.close()
        assert result.returncode == 0, f'{name}: {result.stdout} {result.stderr} (exit {result.returncode})'
        assert not errors, errors
        if expectation in ('cancel', 'pre_cancel'):
            assert elapsed < 2, (name, elapsed)
        if expectation == 'timeout':
            assert 4.5 <= elapsed < 7, (name, elapsed)
        passed += 1


run_case('valid same-user socket', expectation='success')
run_case('reject group-readable socket', mode=0o640)
run_case('reject shared directory', folder_mode=0o750)
run_case('reject symlink socket', symlink=True)
run_case('reject regular file socket', regular=True)
run_case('reject missing newline', payload=b'{"ok":true}')
run_case('reject two response frames', payload=b'{"ok":true}\n{\"other\":true}\n')
run_case('reject oversized response', payload=b'x' * 16385 + b'\n')
run_case('reject empty EOF', payload=b'')
run_case('bounded slow peer', expectation='timeout', delay=6)
run_case('require EOF after valid frame', expectation='timeout', hold_open=6)
run_case('cooperative cancel before IPC', expectation='pre_cancel')
run_case('cooperative cancel while peer pending', expectation='cancel', hold_open=6)
print(f'PASS: {passed} real Unix socket transport cases')
