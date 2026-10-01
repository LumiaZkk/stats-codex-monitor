"""Actual Darwin peer-PID/discovery tests against isolated same-user Unix peers."""
import datetime
import json
import os
import pathlib
import socket
import subprocess
import sys
import tempfile
import threading
import time
import uuid

binary = os.path.abspath(sys.argv[1])
passed = 0


def instant(seconds=0):
    value = datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(seconds=seconds)
    return value.isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def test(name, expectation='none', count=1, mutate=None, nonce_wrong=False,
         slow=False, registry_mode=0o700, file_mode=0o600, symlink=False,
         hardlink=False, replace_during_hello=False, no_registry=False):
    global passed
    with tempfile.TemporaryDirectory(prefix='sdd-', dir='/tmp') as temporary:
        base = pathlib.Path(temporary)
        project = base / 'project'; project.mkdir(mode=0o700)
        registry = project / 'runtime-v1'
        if not no_registry:
            registry.mkdir(mode=registry_mode)
        sockets, records, errors = [], [], []
        for index in range(0 if no_registry else count):
            run = base / f'r{index}'; run.mkdir(mode=0o700)
            path = run / 'native.sock'
            server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            server.bind(str(path)); os.chmod(path, 0o600); server.listen(4); server.settimeout(8)
            sockets.append(server)
            instance = str(uuid.uuid4())
            descriptor = dict(schema_version=1, kind='stats_runtime_descriptor', protocol_version=2,
                              instance_id=instance, uid=os.geteuid(), runtime_pid=os.getpid(),
                              started_at=instant(-1), expires_at=instant(1200), scope_hash='a' * 64,
                              socket_path=str(path))
            if mutate:
                mutate(descriptor)
            file = registry / (instance + '.json')
            file.write_text(json.dumps(descriptor)); os.chmod(file, file_mode)
            if symlink:
                target = run / 'descriptor'; file.rename(target); file.symlink_to(target)
            if hardlink:
                os.link(file, run / 'hardlink')

            def serve(server=server, descriptor=descriptor, file=file, is_slow=(slow is True or (slow == "last" and index == count - 1))):
                try:
                    while True:
                        connection, _ = server.accept()
                        with connection:
                            raw = b''
                            while b'\n' not in raw:
                                part = connection.recv(4096)
                                if not part:
                                    break
                                raw += part
                            if not raw:
                                continue
                            command = json.loads(raw)
                            records.append(command)
                            if command.get('op') == 'hello_native':
                                assert set(command) == {'schema_version', 'op', 'expected_instance_id', 'nonce'}
                                assert command['schema_version'] == 2 and command['expected_instance_id'] == descriptor['instance_id']
                                if is_slow:
                                    time.sleep(6)
                                hello = {k: v for k, v in descriptor.items() if k != 'socket_path'}
                                hello.update(schema_version=2, kind='stats_runtime_hello',
                                             nonce=str(uuid.uuid4()) if nonce_wrong else command['nonce'])
                                if replace_during_hello:
                                    newer = file.with_suffix('.replacement')
                                    newer.write_text(file.read_text()); os.chmod(newer, 0o600); newer.replace(file)
                                connection.sendall((json.dumps({'result': hello}) + '\n').encode())
                            else:
                                assert set(command) == {'schema_version', 'op', 'expected_instance_id', 'client_request'}
                                assert command['schema_version'] == 2 and command['expected_instance_id'] == descriptor['instance_id']
                                assert command['client_request']['fixture'] == 'high-cpu-v1'
                                connection.sendall(b'{"ack":true}\n')
                except (OSError, TimeoutError):
                    pass
                except Exception as error:
                    errors.append(str(error))

            threading.Thread(target=serve, daemon=True).start()
        began = time.monotonic()
        result = subprocess.run([binary, '--discovery-probe', str(registry), expectation], capture_output=True, text=True, timeout=8)
        elapsed = time.monotonic() - began
        for server in sockets:
            server.close()
        assert result.returncode == 0, (name, result.returncode, result.stdout, result.stderr)
        assert not errors, (name, errors)
        if slow and expectation != 'cancel':
            assert 4.5 <= elapsed < 7, (name, elapsed)
        if expectation == 'cancel':
            assert elapsed < 2, (name, elapsed)
        if expectation == 'v2':
            assert len(records) == 2 and records[1]['op'] == 'diagnose_native'
        elif expectation == 'replace':
            assert len(records) == 1, 'replaced descriptor must prevent diagnosis submission'
        elif mutate or symlink or hardlink or file_mode != 0o600 or registry_mode != 0o700:
            assert not records, 'unsafe/stale descriptors must not send even a hello'
        passed += 1


test('one live runtime auto candidate', expectation='one')
test('multiple live runtimes remain distinct choices', expectation='two', count=2)
test('v2 submission bound to discovered instance', expectation='v2')
test('atomic descriptor replacement blocks submission', expectation='replace')
test('descriptor replaced during handshake', expectation='failure', replace_during_hello=True)
test('stale process PID rejected before bytes', expectation='failure', mutate=lambda d: d.update(runtime_pid=os.getpid() + 9999))
test('wrong owner declaration', mutate=lambda d: d.update(uid=os.geteuid() + 1))
test('expired descriptor ignored', mutate=lambda d: d.update(expires_at=instant(-1)))
test('legacy descriptor ignored', mutate=lambda d: d.update(protocol_version=1))
test('symlink descriptor rejected', symlink=True)
test('hardlink descriptor rejected', hardlink=True)
test('shared descriptor rejected', file_mode=0o644)
test('shared registry rejected', registry_mode=0o750, expectation='failure')
test('stale hello challenge blocks ambiguous selection', expectation='failure', nonce_wrong=True)
test('missing registry gives disconnected status', no_registry=True)
test('too many candidates fail closed', count=9, expectation='failure')
test('eight slow peers share total deadline', expectation='failure', count=8, slow=True)
test('partial discovery never silently selects fast peer', expectation='failure', count=2, slow='last')
test('cancel discovery while peer pending', slow=True, expectation='cancel')
print(f'PASS: {passed} real runtime discovery cases')
