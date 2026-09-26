// Use the same poses and paired isolation protocol as the archived B0 run.
process.env.STAGE_B_PHASE = 'B5';
await import('./b0baselinetest.js');
