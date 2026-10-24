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

"""Extracts the variable-length code tables of ITU-T H.262 (02/2000) Annex B from
the text of the published PDF and writes them as Rust source. Every row is
read from the standard; nothing is typed by hand."""
import re, sys

raw = [l.strip() for l in open(sys.argv[1], encoding='utf-8').read().split('\n')]
# Drop page furniture: the marker plus the header, footer and page number after it.
toks, skip = [], 0
for t in raw:
    if not t: continue
    if t.startswith('=== PAGE'): skip = 3; continue
    if skip: skip -= 1; continue
    toks.append(t)

BASE = 0
def index(prefix, after=None):
    after = BASE if after is None else after
    return next(i for i in range(after, len(toks)) if toks[i].startswith(prefix))

CODE = re.compile(r'^[01]+( [01]+)*$')
CODE_S = re.compile(r'^[01]+( [01]+)* ?s$')
INT = re.compile(r'^[–\-]?\d+$')
def num(t): return int(t.replace('–', '-'))
def bits(c): return c.replace(' ', '').rstrip('s')

def pairs(start, stop):
    """code, value, code, value ... from the first code after `start` to `stop`."""
    seq = toks[start:stop]
    i = next(k for k, t in enumerate(seq) if CODE.match(t))
    out = []
    while i + 1 < len(seq):
        code, value = seq[i], seq[i + 1]
        if not CODE.match(code): raise SystemExit(f'not a code: {code!r} near {seq[i-3:i+3]}')
        if value == 'macroblock_escape': out.append((bits(code), 'ESCAPE'))
        elif INT.match(value): out.append((bits(code), num(value)))
        elif re.match(r'^\d+ \(Note\)$', value): out.append((bits(code), int(value.split()[0])))
        else: raise SystemExit(f'not a value: {value!r} after {code!r}')
        i += 2
    return out

def triples(start, stop):
    seq, out, i = toks[start:stop], [], 0
    while i < len(seq):
        t = seq[i]
        if re.match(r'^[01 ]+\(Note 2\)$', t) and seq[i + 1] == 'End of Block':
            out.append((bits(t.split('(')[0].strip()), 'COEF_EOB')); i += 2; continue
        if CODE.match(t) and i + 1 < len(seq) and seq[i + 1] == 'Escape':
            out.append((bits(t), 'COEF_ESCAPE')); i += 2; continue
        m = re.match(r'^([01 ]+ ?s)( \(Note (\d)\))?$', t)
        if m and INT.match(seq[i + 1]) and INT.match(seq[i + 2]):
            note = m.group(3)
            value = f'({num(seq[i + 1])}, {num(seq[i + 2])})'
            # Table B.14 Note 3: "1 s" codes (0, 1) only as a non-intra block's first coefficient.
            out.append((bits(m.group(1)), 'COEF_FIRST' if note == '3' else value))
            i += 3; continue
        i += 1
    return out

BASE = next(i for i, t in enumerate(toks) if t.startswith('Table B.1 ') and 'macroblock_address_increment' in t)
b1 = pairs(index('Table B.1 '), index('macroblock_escape', index('Table B.1 ')) + 1)
b9 = pairs(index('Table B.9 '), index('NOTE', index('Table B.9 ')))
b10 = pairs(index('Table B.10 '), index('Table B.11 '))
print('b10 ok', file=sys.stderr)
b14 = triples(index('Table B.14 '), index('Table B.15 '))
b15_start = index('Table B.15 ')
b15 = triples(b15_start, index('NOTE 1', index('Table B.16 ')))
# B.12 and B.13 follow each other in one block: value pairs after each heading.
lum_start = index('dct_dc_size_luminance', index('Table B.13 ')) + 1
chr_start = index('dct_dc_size_chrominance', lum_start) + 1
b12 = pairs(lum_start, chr_start - 2)
b13 = pairs(chr_start, chr_start + 24)
dm_start = index('Value', index('Table B.11 ')) + 1
b11 = pairs(dm_start, dm_start + 6)

counts = dict(B1=len(b1), B9=len(b9), B10=len(b10), B11=len(b11), B12=len(b12), B13=len(b13), B14=len(b14), B15=len(b15))
print(counts, file=sys.stderr)

def rs(name, rows, kind):
    t = 'i32' if kind == 'pair' else 'Coef'
    body = '\n'.join(f'    ("{c}", {v}),' if kind == 'pair' or v.startswith('COEF') else f'    ("{c}", Coef::RunLevel{v}),' for c, v in rows)
    body = body.replace('COEF_EOB', 'Coef::EndOfBlock').replace('COEF_ESCAPE', 'Coef::Escape').replace('COEF_FIRST', 'Coef::FirstOne')
    return f'pub(crate) const {name}: &[(&str, {t})] = &[\n{body}\n];\n'

out = ['// Generated from ITU-T H.262 (02/2000) Annex B by extract_tables.py (scratch',
       '// tool, see docs/trier-mpeg-video.md). Codes are bit strings without the',
       '// trailing sign bit "s". Do not edit by hand.',
       '#![allow(dead_code)]',
       'use super::tables::{Coef, ESCAPE};', '']
out += [rs('MB_ADDRESS_INCREMENT', b1, 'pair'), rs('CODED_BLOCK_PATTERN', b9, 'pair'),
        rs('MOTION_CODE', b10, 'pair'), rs('DMVECTOR', b11, 'pair'),
        rs('DCT_DC_SIZE_LUMINANCE', b12, 'pair'), rs('DCT_DC_SIZE_CHROMINANCE', b13, 'pair'),
        rs('DCT_TABLE_ZERO', b14, 'triple'), rs('DCT_TABLE_ONE', b15, 'triple')]
open(sys.argv[2], 'w', encoding='utf-8').write('\n'.join(out))
