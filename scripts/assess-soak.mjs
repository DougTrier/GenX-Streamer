/*
 * Copyright 2026 Doug Trier
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { createReadStream } from 'node:fs';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const finite = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
function quantile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) * fraction)];
}
/** Measurements never turn a retrospective budget into invariant acceptance. */
export function summarizeSoak(report, samples, warmupSeconds = 300) {
  if (!finite(warmupSeconds) || warmupSeconds > 3600) throw new Error('Invalid warmup');
  if (!Array.isArray(samples) || samples.length < 2 || samples.length > 100000)
    throw new Error('Invalid sample count');
  let previous = -1;
  const series = {
    heapBytes: [],
    privateBytes: [],
    workingSetBytes: [],
    handles: [],
    appPssBytes: [],
  };
  const resources = {
    activeSockets: { maximum: null, samples: 0 },
    activeResponses: { maximum: null, samples: 0 },
    timers: { maximum: null, samples: 0 },
  };
  for (const sample of samples) {
    if (!finite(sample.elapsedSeconds) || sample.elapsedSeconds <= previous)
      throw new Error('Samples must have strictly increasing elapsed time');
    previous = sample.elapsedSeconds;
    for (const field of Object.keys(resources)) {
      const value = sample.fixture?.[field];
      if (finite(value)) {
        resources[field].maximum = Math.max(resources[field].maximum ?? 0, value);
        resources[field].samples++;
      }
    }
    if (sample.elapsedSeconds < warmupSeconds) continue;
    if (finite(sample.heapBytes)) series.heapBytes.push([sample.elapsedSeconds, sample.heapBytes]);
    if (finite(sample.appTotalPssKb))
      series.appPssBytes.push([sample.elapsedSeconds, sample.appTotalPssKb * 1024]);
    if (Array.isArray(sample.processes) && sample.processes.length > 0) {
      if (sample.processes.length > 32)
        throw new Error('Process owner count exceeds sampler bound');
      for (const [metric, field] of [
        ['privateBytes', 'PrivateMemorySize64'],
        ['workingSetBytes', 'WorkingSet64'],
        ['handles', 'HandleCount'],
      ]) {
        if (sample.processes.every((process) => finite(process[field])))
          series[metric].push([
            sample.elapsedSeconds,
            sample.processes.reduce((sum, process) => sum + process[field], 0),
          ]);
      }
    }
  }
  const measurements = {};
  for (const [name, points] of Object.entries(series)) {
    if (points.length < 2) {
      measurements[name] = { status: 'MISSING', samples: points.length };
      continue;
    }
    const count = Math.min(30, Math.max(2, Math.floor(points.length / 4)));
    const start = points.slice(0, count).map((point) => point[1]);
    const tail = points.slice(-count).map((point) => point[1]);
    const meanTime = points.reduce((sum, point) => sum + point[0], 0) / points.length;
    const meanValue = points.reduce((sum, point) => sum + point[1], 0) / points.length;
    const denominator = points.reduce((sum, point) => sum + (point[0] - meanTime) ** 2, 0);
    const slope =
      points.reduce((sum, point) => sum + (point[0] - meanTime) * (point[1] - meanValue), 0) /
      denominator;
    const observedSpanSeconds = points.at(-1)[0] - points[0][0];
    measurements[name] = {
      status: 'MEASURED',
      samples: points.length,
      windowSamples: count,
      warmMedian: quantile(start, 0.5),
      tailMedian: quantile(tail, 0.5),
      maximum: Math.max(...points.map((point) => point[1])),
      p95: quantile(
        points.map((point) => point[1]),
        0.95,
      ),
      tailMedianChange: quantile(tail, 0.5) - quantile(start, 0.5),
      observedSpanSeconds,
      trendStatus: observedSpanSeconds >= 600 ? 'DESCRIPTIVE' : 'TOO_SHORT',
      linearChangePerHour: observedSpanSeconds >= 600 ? slope * 3600 : null,
    };
  }
  return {
    schemaVersion: 1,
    status: 'MEASUREMENTS_ONLY',
    scope: 'Observed soak memory/resource summary; not P08 or release acceptance',
    terminalReportStatus: ['PASS', 'FAIL'].includes(report?.status) ? report.status : 'MISSING',
    warmupSeconds,
    samples: samples.length,
    lastElapsedSeconds: previous,
    memoryAcceptance:
      'NOT_VERIFIED: device-specific prospective budgets and final-byte coverage required',
    measurements,
    maximumObservedFixtureResources: resources,
    notes: [
      'Windows process measurements are aggregate owned sampler processes; Android PSS is KiB converted to bytes.',
      'Working set, private memory, PSS and JavaScript heap measure different things and are not interchangeable.',
      'Linear change is descriptive, not a leak diagnosis; missing samples, process turnover and cleanup require separate review.',
    ],
  };
}
async function boundedFile(filename, limit) {
  const metadata = await lstat(filename);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > limit)
    throw new Error('Input must be a bounded regular file');
}
export async function assessSoak(reportPath, samplesPath, warmupSeconds = 300) {
  await boundedFile(reportPath, 2 * 1024 * 1024);
  await boundedFile(samplesPath, 128 * 1024 * 1024);
  const reportBytes = await readFile(reportPath);
  const report = JSON.parse(reportBytes.toString('utf8'));
  const hash = createHash('sha256');
  const input = createReadStream(samplesPath);
  let actualBytes = 0;
  input.on('data', (chunk) => {
    actualBytes += chunk.length;
    if (actualBytes > 128 * 1024 * 1024) input.destroy(new Error('Sample bytes exceed bound'));
    else hash.update(chunk);
  });
  const lines = createInterface({ input, crlfDelay: Infinity });
  const samples = [];
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      if (Buffer.byteLength(line, 'utf8') > 512 * 1024 || samples.length >= 100000)
        throw new Error('Sample input bounds exceeded');
      const sample = JSON.parse(line);
      // Drop verbose provider/request histories and all process names/addresses immediately.
      samples.push({
        elapsedSeconds: sample.elapsedSeconds,
        heapBytes: sample.heapBytes,
        appTotalPssKb: sample.appTotalPssKb,
        processes: sample.processes?.map((process) => ({
          PrivateMemorySize64: process.PrivateMemorySize64,
          WorkingSet64: process.WorkingSet64,
          HandleCount: process.HandleCount,
        })),
        fixture: {
          activeSockets: sample.fixture?.activeSockets,
          activeResponses: sample.fixture?.activeResponses,
          timers: sample.fixture?.timers,
        },
      });
    }
  } finally {
    lines.close();
    input.destroy();
  }
  return {
    ...summarizeSoak(report, samples, warmupSeconds),
    reportSha256: createHash('sha256').update(reportBytes).digest('hex'),
    samplesSha256: hash.digest('hex'),
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const options = new Map();
  for (let index = 0; index < args.length; index += 2) {
    if (
      !['--report', '--samples', '--output', '--warmup'].includes(args[index]) ||
      !args[index + 1] ||
      options.has(args[index])
    )
      throw new Error('Usage: --report file --samples file --output new-file [--warmup seconds]');
    options.set(args[index], args[index + 1]);
  }
  for (const name of ['--report', '--samples', '--output'])
    if (!options.has(name)) throw new Error('Missing required input/output');
  const result = await assessSoak(
    options.get('--report'),
    options.get('--samples'),
    Number(options.get('--warmup') ?? 300),
  );
  await writeFile(options.get('--output'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  console.log(
    JSON.stringify({
      status: result.status,
      samples: result.samples,
      memoryAcceptance: result.memoryAcceptance,
    }),
  );
}
