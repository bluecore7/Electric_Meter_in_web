const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'frontend', 'app.js');
let content = fs.readFileSync(filePath, 'utf8');

// 1. Remove ANOMALY_META
const startAnomalyMeta = content.indexOf('const ANOMALY_META = {');
if (startAnomalyMeta !== -1) {
    const endAnomalyMeta = content.indexOf('function renderAnomalyLog(anomalies) {');
    if (endAnomalyMeta !== -1) {
        content = content.substring(0, startAnomalyMeta) + content.substring(endAnomalyMeta);
    }
}

// 2. Remove renderAnomalyLog
const startRenderAnomaly = content.indexOf('function renderAnomalyLog(anomalies) {');
if (startRenderAnomaly !== -1) {
    const endRenderAnomaly = content.indexOf('//  ML INFERENCE', startRenderAnomaly);
    if (endRenderAnomaly !== -1) {
        // Find the start of the block comment
        const startBlock = content.lastIndexOf('// ============================================================', endRenderAnomaly);
        if (startBlock !== -1) {
            content = content.substring(0, startRenderAnomaly) + content.substring(startBlock);
        }
    }
}

// 3. Remove runMLInference and the giant comment block before it
const startRunML = content.indexOf('//  ML INFERENCE');
if (startRunML !== -1) {
    // Find previous // === to grab the whole block
    const blockStart = content.lastIndexOf('// ======', startRunML);
    
    // Find end of runMLInference
    const endRunML = content.indexOf('// ============================================================', startRunML);
    if (endRunML !== -1) {
        // Also look for the 'function runMLInference' to make sure we got what we wanted
        if (blockStart !== -1) {
            content = content.substring(0, blockStart) + content.substring(endRunML);
        }
    }
}

// 4. Remove all the unused fetch functions for prediction page
const funcsToRemove = [
    'async function fetchMonthlyPrediction() {',
    'async function fetchBillRisk() {',
    'async function fetchLoadType() {',
    'async function fetchForecast() {',
    'async function fetchIFAnomalies() {'
];

for (const func of funcsToRemove) {
    const startIdx = content.indexOf(func);
    if (startIdx !== -1) {
        // Find the next `// ── ` or `// ======` after it
        let endIdx = content.indexOf('// ── ', startIdx + 10);
        if (endIdx === -1) endIdx = content.indexOf('// ===', startIdx + 10);
        
        // Also look for the preceding comment
        const blockStart = content.lastIndexOf('// ── ', startIdx);
        if (blockStart !== -1 && blockStart > startIdx - 200) {
            content = content.substring(0, blockStart) + content.substring(endIdx);
        } else {
            content = content.substring(0, startIdx) + content.substring(endIdx);
        }
    }
}

fs.writeFileSync(filePath, content, 'utf8');
console.log('Successfully cleaned app.js of legacy logic.');
