const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'frontend', 'app.js');
let lines = fs.readFileSync(filePath, 'utf8').split('\n');

// The orphaned runMLInference body spans from the "Anomaly type metadata" comment
// down to the closing } on line 904 (1-indexed). 
// We need to find and delete lines 748-905 (0-indexed: 747-904).
// 
// Strategy: find the marker lines and slice them out surgically.

let startIdx = -1;
let endIdx   = -1;

for (let i = 0; i < lines.length; i++) {
  if (startIdx === -1 && lines[i].trim() === '' && i > 740) {
    // Look for the blank line before the orphaned block 
    // Right after the closing } of renderHourlyCharts
    const nextLine = lines[i + 1]?.trim() || '';
    if (nextLine.startsWith('// ============') ||
        nextLine.startsWith('// Anomaly') ||
        nextLine.startsWith('  // ── Critical fix')) {
      startIdx = i;
    }
  }
  // Find the "BILLING — all data from Firebase" section that's REAL (has the async function after it)
  if (lines[i].includes('BILLING') && lines[i].includes('all data from Firebase')) {
    // Check if this is the REAL billing section (followed by loadBillingHistory) or the fake one
    let j = i + 1;
    while (j < lines.length && (lines[j].trim() === '' || lines[j].trim().startsWith('//'))) j++;
    if (lines[j]?.trim().startsWith('async function loadBillingHistory')) {
      // This is the real billing section
      if (endIdx === -1 && i > 700) {
        endIdx = i - 1; // end the deletion one line before this real section
        break;
      }
    }
  }
}

console.log(`Removing orphaned block from line ${startIdx + 1} to ${endIdx + 1}`);

if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
  lines.splice(startIdx, endIdx - startIdx);
  fs.writeFileSync(filePath, lines.join('\n'), 'utf8');
  console.log('✓ Orphaned runMLInference body removed successfully.');
} else {
  console.log('⚠ Could not find markers. No changes made. startIdx=' + startIdx + ' endIdx=' + endIdx);
}
