import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import assert from 'node:assert/strict'

test('agent-computer image installs the shell and JSON tools required by the bash runtime', async () => {
  const dockerfile = await readFile(
    new URL('../../../server/docker/agent-computer.Dockerfile', import.meta.url),
    'utf8',
  )
  assert.match(dockerfile, /apt-get install[\s\S]*\bbash\b/)
  assert.match(dockerfile, /apt-get install[\s\S]*\bjq\b/)
})

test('agent-computer uses the trusted bootstrap and a capless supervisor boundary', async () => {
  const dockerfile = await readFile(
    new URL('../../../server/docker/agent-computer.Dockerfile', import.meta.url),
    'utf8',
  )
  const bootstrap = await readFile(
    new URL('../../../server/docker/agent-computer-bootstrap.sh', import.meta.url),
    'utf8',
  )
  const supervisor = await readFile(
    new URL('../../../server/docker/agent-computer-entrypoint.sh', import.meta.url),
    'utf8',
  )

  assert.match(dockerfile, /apt-get install[\s\S]*\butil-linux\b/)
  assert.match(dockerfile, /groupadd --gid 65532 cumora-agent/)
  assert.match(dockerfile, /groupadd --gid 65533 cumora-fuse/)
  assert.match(dockerfile, /ENTRYPOINT \["\/usr\/local\/bin\/cumora-agent-bootstrap"\]/)
  assert.match(bootstrap, /--ready-fd 4/)
  assert.match(bootstrap, /--lifetime-fd 5/)
  assert.match(bootstrap, /env -u CUMORA_AGENT_RUNTIME_TOKEN/)
  assert.match(bootstrap, /--bounding-set=-all/)
  assert.match(bootstrap, /--no-new-privs/)
  assert.match(supervisor, /refusing direct root invocation/)
  assert.match(supervisor, /lifetime-eof/)
  assert.match(supervisor, /fuse\.cumora-workspace/)
})
