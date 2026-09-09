const fs = require('node:fs')

function procStatus() {
  const source = fs.readFileSync('/proc/self/status', 'utf8')
  const status = {}
  for (const key of ['Uid', 'Gid', 'CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb', 'NoNewPrivs']) {
    status[key] = source.match(new RegExp(`^${key}:\\s+([^\\n]+)$`, 'm'))?.[1]?.trim() ?? ''
  }
  return status
}

function writeAndFsync(path, body) {
  const fd = fs.openSync(path, 'w', 0o644)
  try {
    fs.writeSync(fd, body)
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
}

writeAndFsync('/workspace/probe.txt', 'fuse-fixture')
writeAndFsync('/workspace/probe-fsync.txt', 'fsync-fixture')
const probe = {
  uid: process.getuid(),
  gid: process.getgid(),
  runtimeTokenPresent: typeof process.env.CUMORA_AGENT_RUNTIME_TOKEN === 'string' && process.env.CUMORA_AGENT_RUNTIME_TOKEN.length > 0,
  status: procStatus(),
  read: fs.readFileSync('/workspace/probe.txt', 'utf8'),
  fsyncRead: fs.readFileSync('/workspace/probe-fsync.txt', 'utf8'),
  owner: `${fs.statSync('/workspace/probe.txt').uid}:${fs.statSync('/workspace/probe.txt').gid}`,
}
writeAndFsync('/tmp/cumora-agent-boundary-fixture.json', JSON.stringify(probe))
console.log(`BOUNDARY_PROBE ${JSON.stringify(probe)}`)

let stopping = false
function stop() {
  if (stopping) return
  stopping = true
  writeAndFsync('/workspace/final-stop.txt', 'final-fsync-fixture')
  console.log('BOUNDARY_FINAL_FSYNC')
  setTimeout(() => process.exit(0), 100)
}
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
setInterval(() => {}, 1000)
