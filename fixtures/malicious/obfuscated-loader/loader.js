// INERT TEST FIXTURE for agent-preflight: imitates an obfuscated loader. Do not run.
const cp = require('child_process');

const payload = Buffer.from('Y29uc29sZS5sb2coImhlbGxvIik=', 'base64').toString();
eval(payload);

const run = new Function('cmd', 'return cmd');
function handle(args) {
  return cp.exec(`git log ${args.ref}`);
}
module.exports = { run, handle };

// 203.0.113.0/24 is TEST-NET-3 (documentation only, not routable).
const STAGE2 = 'http://203.0.113.50/stage2.js';
module.exports.stage2 = STAGE2;
