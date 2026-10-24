# Copyright 2026 Doug Trier
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""Metadata-only bounded XMLTV measurement. No payload files or retries.

HTTPS connects to a validated public DNS answer while retaining the original TLS
hostname. The event parser holds IDs/counters only, never an XML element tree.

Usage: python -B -X utf8 scripts/epg-source-audit.py --candidates candidates.json
       --output metadata-report.json --profile diagnostic
Production uses existing app caps20MiB/64MiB; diagnostic uses8MiB/20MiB.
Both are one-pass research measurements, never source promotion or app proof.
"""
import argparse
import concurrent.futures
import datetime as dt
import hashlib
import http.client
import ipaddress
import json
import re
import socket
import ssl
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.parsers.expat
import zlib
from pathlib import Path

INPUT = 8 * 1024 * 1024
EXPANDED = 20 * 1024 * 1024
JOB = 200 * 1024 * 1024
WHOLE = 45
SOCKET = 8
CHUNK = 32 * 1024
UTC = dt.timezone.utc
PROFILES = {'diagnostic': (INPUT, EXPANDED), 'production': (20 * 1024 * 1024, 64 * 1024 * 1024)}


class Refusal(Exception):
    pass


def instant(text):
    parts = text.split()
    if not 1 <= len(parts) <= 2 or not re.fullmatch(r'\d{12}(?:\d{2})?', parts[0]):
        raise ValueError('timestamp')
    naive = dt.datetime.strptime(parts[0], '%Y%m%d%H%M%S' if len(parts[0]) == 14 else '%Y%m%d%H%M')
    minutes = 0
    if len(parts) == 2:
        if not re.fullmatch(r'[+-]\d{4}', parts[1]):
            raise ValueError('offset')
        hour, minute = int(parts[1][1:3]), int(parts[1][3:5])
        if hour > 14 or minute > 59 or hour == 14 and minute:
            raise ValueError('offset')
        minutes = (hour * 60 + minute) * (1 if parts[1][0] == '+' else -1)
    return naive.replace(tzinfo=UTC) - dt.timedelta(minutes=minutes), len(parts) == 1


def iso(value):
    return value.isoformat().replace('+00:00', 'Z') if value is not None else None


class Meter:
    def __init__(self, now, expanded_limit=EXPANDED):
        self.now, self.limit, self.bytes = now, expanded_limit, 0
        self.ids, self.refs = set(), {}
        self.depth, self.root, self.program, self.in_title = 0, False, None, False
        self.title_chars = 0
        self.declared = self.duplicates = self.programs = self.invalid = self.missing = self.offsetless = 0
        self.parser = xml.parsers.expat.ParserCreate()
        self.parser.StartElementHandler = self.start
        self.parser.EndElementHandler = self.end
        self.parser.CharacterDataHandler = self.text
        self.parser.EntityDeclHandler = self.entity
        self.parser.ExternalEntityRefHandler = self.external

    def entity(self, *args):
        raise Refusal('entity-declaration')

    def external(self, *args):
        raise Refusal('external-entity')

    def start(self, name, attrs):
        self.depth += 1
        if self.depth > 64:
            raise Refusal('xml-depth-limit')
        if self.depth == 1:
            if name != 'tv':
                raise Refusal('not-xmltv')
            self.root = True
        if self.depth == 2 and name == 'channel':
            self.declared += 1
            key = attrs.get('id', '')
            if not key.strip() or len(key.encode()) > 16384:
                raise Refusal('channel-id-invalid')
            if key in self.ids:
                self.duplicates += 1
            self.ids.add(key)
            if self.declared > 100000:
                raise Refusal('channel-count-limit')
        if self.depth == 2 and name == 'programme':
            self.programs += 1
            if self.programs > 500000:
                raise Refusal('program-count-limit')
            key = attrs.get('channel', '')
            if not key.strip() or len(key.encode()) > 16384:
                raise Refusal('program-channel-invalid')
            if key not in self.refs:
                if len(self.refs) >= 100000:
                    raise Refusal('reference-count-limit')
                self.refs[key] = dict(total=0, usable=0, current=0, future=0, knownFuture=0, first=None, last=None, stop=None)
            self.refs[key]['total'] += 1
            self.program = dict(key=key, start=None, stop=None, valid=True, title=False)
            self.title_chars = 0
            try:
                self.program['start'], absent = instant(attrs.get('start', ''))
                self.offsetless += int(absent)
                if 'stop' in attrs:
                    self.program['stop'], absent = instant(attrs['stop'])
                    self.offsetless += int(absent)
                    if self.program['stop'] <= self.program['start']:
                        raise ValueError('order')
                else:
                    self.missing += 1
            except (ValueError, OverflowError):
                self.program['valid'] = False
                self.invalid += 1
        if self.program is not None and self.depth == 3 and name == 'title':
            self.in_title = True

    def text(self, text):
        if self.in_title and self.program is not None:
            self.title_chars += len(text.encode())
            if self.title_chars > 16384:
                raise Refusal('title-limit')
            self.program['title'] |= bool(text.strip())

    def end(self, name):
        if name == 'title' and self.depth == 3:
            self.in_title = False
        if name == 'programme' and self.depth == 2:
            p = self.program
            if p['valid'] and p['title']:
                r = self.refs[p['key']]
                r['usable'] += 1
                r['future'] += int(p['start'] > self.now)
                r['knownFuture'] += int(p['start'] > self.now and p['stop'] is not None)
                r['current'] += int(p['start'] <= self.now and p['stop'] is not None and self.now < p['stop'])
                r['first'] = min(r['first'], p['start']) if r['first'] else p['start']
                r['last'] = max(r['last'], p['start']) if r['last'] else p['start']
                if p['stop']:
                    r['stop'] = max(r['stop'], p['stop']) if r['stop'] else p['stop']
            self.program = None
        self.depth -= 1

    def feed(self, data):
        self.bytes += len(data)
        if self.bytes > self.limit:
            raise Refusal('expanded-limit')
        self.parser.Parse(data, False)

    def finish(self):
        self.parser.Parse(b'', True)
        if not self.root:
            raise Refusal('not-xmltv')
        known = [r for key, r in self.refs.items() if key in self.ids]
        values = lambda field: [r[field] for r in known if r[field] is not None]
        return dict(declaredChannelCount=self.declared, uniqueDeclaredChannelIdCount=len(self.ids),
                    usableChannelIdCount=sum(r['usable'] > 0 for r in known),
                    channelsWithUsablePrograms=sum(r['usable'] > 0 for r in known),
                    duplicateChannelIdCount=self.duplicates, programCount=self.programs,
                    usableProgramCount=sum(r['usable'] for r in known),
                    currentProgramCount=sum(r['current'] for r in known),
                    futureProgramCount=sum(r['future'] for r in known),
                    knownEndFutureProgramCount=sum(r['knownFuture'] for r in known),
                    invalidTimestampCount=self.invalid, missingEndCount=self.missing,
                    missingOffsetTimestampCount=self.offsetless,
                    unknownChannelProgramCount=sum(r['total'] for key, r in self.refs.items() if key not in self.ids),
                    firstStart=iso(min(values('first'), default=None)),
                    lastStart=iso(max(values('last'), default=None)),
                    lastStop=iso(max(values('stop'), default=None)), expandedBytes=self.bytes,
                    coverageScope='Aggregate extrema only; no per-channel continuity or seven-day coverage claim')


class Decoder:
    def __init__(self, meter):
        self.meter, self.prefix, self.gzip, self.decoder, self.member_end = meter, b'', None, None, False

    def feed(self, data):
        if self.gzip is None:
            self.prefix += data
            if len(self.prefix) < 2:
                return
            self.gzip = self.prefix.startswith(b'\x1f\x8b')
            data, self.prefix = self.prefix, b''
        if not self.gzip:
            self.meter.feed(data)
            return
        while data:
            if self.decoder is None or self.member_end:
                self.decoder, self.member_end = zlib.decompressobj(31), False
            while data:
                output = self.decoder.decompress(data, min(CHUNK, self.meter.limit - self.meter.bytes + 1))
                self.meter.feed(output)
                if self.decoder.eof:
                    data, self.member_end = self.decoder.unused_data, True
                    break
                data = self.decoder.unconsumed_tail

    def finish(self):
        if self.gzip is None:
            self.meter.feed(self.prefix)
        if self.gzip and (self.decoder is None or not self.member_end):
            raise Refusal('gzip-truncated')
        return self.meter.finish()


def dns(host, port, **kwargs):
    # An owned subprocess makes DNS itself bounded; subprocess.run kills and
    # waits its own child on timeout, rather than abandoning a resolver thread.
    script = 'import socket,json,sys; print(json.dumps(socket.getaddrinfo(sys.argv[1],443,type=socket.SOCK_STREAM)))'
    try:
        result = subprocess.run([sys.executable, '-B', '-c', script, host], capture_output=True,
                                timeout=min(SOCKET, kwargs.get('timeout', SOCKET)), check=True,
                                creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == 'win32' else 0)
        return json.loads(result.stdout)
    except (subprocess.SubprocessError, ValueError):
        raise Refusal('dns-failed') from None


def syntax(url):
    p = urllib.parse.urlsplit(url)
    if p.scheme != 'https' or not p.hostname or p.username or p.password or p.fragment or p.port not in (None, 443):
        raise Refusal('destination-refused')
    if any(ord(c) <= 32 or ord(c) == 127 for c in url) or '\\' in url:
        raise Refusal('destination-refused')
    return p


def admit(url, resolver=dns):
    p = syntax(url)
    answers = resolver(p.hostname, 443, type=socket.SOCK_STREAM)
    addresses = []
    for answer in answers:
        ip = ipaddress.ip_address(answer[4][0])
        if not ip.is_global:
            raise Refusal('dns-nonpublic')
        addresses.append(str(ip))
    if not addresses:
        raise Refusal('dns-empty')
    return p.hostname.lower(), addresses[0]


class PinnedConnection(http.client.HTTPSConnection):
    def __init__(self, host, *, pinned, deadline, **kwargs):
        self.pinned, self.deadline = pinned, deadline
        super().__init__(host, **kwargs)

    def connect(self):
        remaining = self.deadline - time.monotonic()
        if remaining <= 0:
            raise Refusal('whole-deadline')
        sock = socket.create_connection((self.pinned, 443), timeout=min(SOCKET, remaining))
        try:
            self.sock = self._context.wrap_socket(sock, server_hostname=self.host)
        except BaseException:
            sock.close()
            raise


class JobBudget:
    def __init__(self, limit=JOB):
        self.used, self.limit, self.lock = 0, limit, threading.Lock()
        self.hosts = {}

    def host_lock(self, hostname):
        with self.lock:
            return self.hosts.setdefault(hostname, threading.Lock())

    def take(self, count):
        with self.lock:
            if self.used + count > self.limit:
                raise Refusal('job-byte-limit')
            self.used += count

    def reserve(self, count):
        with self.lock:
            amount = min(count, self.limit - self.used)
            if amount <= 0:
                raise Refusal('job-byte-limit')
            self.used += amount
            return amount

    def refund(self, count):
        with self.lock:
            self.used -= count


def audit_one(source, endpoint, budget, profile='diagnostic'):
    input_limit, expanded_limit = PROFILES[profile]
    start = time.monotonic()
    deadline = start + WHOLE
    now = dt.datetime.now(UTC)
    result = dict(sourceId=source['id'], endpoint=endpoint, finalUrl=None,
                  checkedUtc=iso(now), operationalStatus='Unverified', reasonCode=None,
                  dataTerms=source.get('dataRedistribution', 'Unknown'),
                  codeLicense=source.get('codeLicenseReported'), termsStatus='Not established by feed measurement',
                  profile=profile, advertisedContentLength=None,
                  httpStatus=None, inputBytes=0, expandedBytes=0, feedSha256=None, complete=False, responseComplete=False)
    sha = hashlib.sha256()
    meter = Meter(now, expanded_limit)
    decoder = Decoder(meter)
    redirects = 0

    class Handler(urllib.request.HTTPSHandler):
        def https_open(self, request):
            if time.monotonic() >= deadline:
                raise Refusal('whole-deadline')
            hostname, address = admit(request.full_url, lambda host, port, **kw: dns(host, port, timeout=max(.001, deadline - time.monotonic())))
            if time.monotonic() >= deadline:
                raise Refusal('whole-deadline')
            def connection(host, **kw):
                kw['timeout'] = min(SOCKET, max(.001, deadline - time.monotonic()))
                return PinnedConnection(host, pinned=address, deadline=deadline, **kw)
            lock = budget.host_lock(hostname)
            if not lock.acquire(timeout=max(0, deadline - time.monotonic())):
                raise Refusal('whole-deadline')
            try:
                response = self.do_open(connection, request, context=ssl.create_default_context())
                original_close = response.close
                released = False
                def close():
                    nonlocal released
                    try:
                        original_close()
                    finally:
                        if not released:
                            released = True
                            lock.release()
                response.close = close
                return response
            except BaseException:
                lock.release()
                raise

    class Redirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            nonlocal redirects
            redirects += 1
            if redirects > 5:
                raise Refusal('redirect-limit')
            # Syntax/DNS admission is repeated by the actual HTTPS handler;
            # rejecting schemes here also prevents urllib's HTTP handler path.
            p = urllib.parse.urlsplit(newurl)
            if p.scheme != 'https':
                raise Refusal('destination-refused')
            return super().redirect_request(req, fp, code, msg, headers, newurl)

    try:
        syntax(endpoint)  # Refuse HTTP before urllib's default HTTP handler can run.
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), Handler(), Redirect())
        request = urllib.request.Request(endpoint, headers={'User-Agent': 'GenX-EPG-metadata-audit/1', 'Accept-Encoding': 'identity'})
        with opener.open(request, timeout=SOCKET) as response:
            result['httpStatus'], result['finalUrl'] = response.status, response.geturl()
            encoding = response.headers.get('Content-Encoding', 'identity').lower().strip()
            if encoding not in ('identity', 'gzip', 'x-gzip'):
                raise Refusal('content-encoding-unsupported')
            length = response.headers.get('Content-Length')
            result['advertisedContentLength'] = int(length) if length is not None else None
            if result['advertisedContentLength'] is not None and result['advertisedContentLength'] < 0:
                raise Refusal('response-length-invalid')
            if result['advertisedContentLength'] is not None and result['advertisedContentLength'] > input_limit:
                raise Refusal('input-limit')
            while True:
                if response.length == 0 or response.fp is None:
                    break
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise Refusal('whole-deadline')
                if result['inputBytes'] == input_limit:
                    if response.length == 0:
                        break
                    # Unknown-length body at the cap is unmeasured, never a
                    # truncated success and never an extra budget-probe byte.
                    raise Refusal('input-limit')
                response.fp.raw._sock.settimeout(min(SOCKET, remaining))
                reserved = budget.reserve(min(CHUNK, input_limit - result['inputBytes']))
                try:
                    data = response.read1(reserved)
                except BaseException:
                    budget.refund(reserved)
                    raise
                budget.refund(reserved - len(data))
                if not data:
                    break
                result['inputBytes'] += len(data)
                sha.update(data)
                if result['inputBytes'] > input_limit:
                    raise Refusal('input-limit')
                decoder.feed(data)
            if response.length not in (None, 0):
                raise Refusal('body-truncated')
            result['responseComplete'] = True
            result.update(decoder.finish())
            result['complete'] = True
            result['operationalStatus'] = 'Verified Active' if result['currentProgramCount'] or result['futureProgramCount'] else 'Stale' if result['usableProgramCount'] else 'Unverified'
            result['reasonCode'] = 'measured-xmltv' if result['usableProgramCount'] else 'empty-or-no-usable-programs'
    except urllib.error.HTTPError as error:
        result['httpStatus'] = error.code
        result['finalUrl'] = error.geturl()
        result['operationalStatus'] = 'Unavailable'
        result['reasonCode'] = 'http-status'
        error.close()
    except Refusal as error:
        result['reasonCode'] = str(error)
    except (xml.parsers.expat.ExpatError, zlib.error):
        result['reasonCode'] = 'malformed-xml-or-gzip'
    except (urllib.error.URLError, OSError, TimeoutError, http.client.HTTPException):
        result['reasonCode'] = 'transport-failed'
        result['operationalStatus'] = 'Unavailable'
    except (ValueError, AttributeError):
        result['reasonCode'] = 'response-metadata-unusable'
    finally:
        result['elapsedSeconds'] = round(time.monotonic() - start, 3)
        result['expandedBytes'] = meter.bytes
        result['feedSha256'] = sha.hexdigest() if result['inputBytes'] else None
        result['shaScope'] = 'complete-response' if result['responseComplete'] else 'received-prefix-only'
        # A generator's GPL or other code license is not a schedule-data restriction.
        restricted = source.get('status') == 'Restricted' or 'personal/noncommercial' in result['dataTerms'].lower()
        result['classification'] = 'Restricted' if restricted else result['operationalStatus']
    return result


def run(candidates, profile='diagnostic'):
    input_limit, expanded_limit = PROFILES[profile]
    jobs = [(source, endpoint) for source in candidates['sources'] for endpoint in source.get('candidates', [])]
    if len(jobs) > 100 or len({endpoint for _, endpoint in jobs}) != len(jobs):
        raise Refusal('candidate-count-or-duplicate')
    # One task per hostname performs that host's endpoints sequentially. Two
    # executor workers bound global connections without starving another host.
    groups = {}
    for source, endpoint in jobs:
        host = urllib.parse.urlsplit(endpoint).hostname
        groups.setdefault(host, []).append((source, endpoint))
    budget = JobBudget()
    def group(entries):
        return [audit_one(source, endpoint, budget, profile) for source, endpoint in entries]
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
        nested = list(executor.map(group, groups.values()))
    results = {row['endpoint']: row for rows in nested for row in rows}
    return dict(schemaVersion=1, scope='Metadata-only one-pass endpoint measurement; no feed promotion, XML retention, redistribution or per-channel coverage claim',
                toolSha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                profile=profile,
                limits=dict(endpoints=100, globalWorkers=2, perHostname=1, socketSeconds=SOCKET, wholeEndpointSeconds=WHOLE, inputBytes=input_limit, expandedBytes=expanded_limit, jobBytes=JOB, redirects=5),
                totalReceivedBytes=budget.used, results=[results[e] for _, e in jobs])


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--candidates', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--profile', choices=tuple(PROFILES), default='diagnostic')
    args = parser.parse_args()
    candidate_bytes = Path(args.candidates).read_bytes()
    if len(candidate_bytes) > 1024 * 1024:
        raise SystemExit('Candidate metadata exceeds limit')
    report = run(json.loads(candidate_bytes.decode('utf-8-sig')), args.profile)
    report['candidateSha256'] = hashlib.sha256(candidate_bytes).hexdigest()
    Path(args.output).write_text(json.dumps(report, indent=2), encoding='utf-8')
