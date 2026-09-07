# Agent-scoped Claude providers

A paired computer can give different Agents different Claude-compatible
endpoints and credentials. Profiles are configured by the computer's operator;
workspace owners/admins select a profile in the Agent editor. The first version
supports Claude in secure BYOA mode only.

## Configure the computer

Create `~/.cumora/providers.json` as the user running the daemon. Keep this file
outside Agent homes and source control. On macOS/Linux it must be owned by that
user with permissions `0600`; symlinks and group/world-readable files are rejected.

```sh
mkdir -p ~/.cumora
(umask 077; touch ~/.cumora/providers.json)
chmod 600 ~/.cumora/providers.json
```

Edit the file with an editor on that computer. This example uses placeholder
credentials and model ids; replace them with values supported by your gateway:

```json
{
  "version": 1,
  "profiles": [
    {
      "id": "work",
      "label": "Work gateway",
      "baseUrl": "https://gateway.example.com",
      "model": "gateway/main-model",
      "fastModel": "gateway/fast-model",
      "auth": { "apiKey": "replace-with-local-credential" }
    },
    {
      "id": "personal",
      "label": "Personal gateway",
      "baseUrl": "https://personal.example.com",
      "model": "personal/main-model",
      "fastModel": "personal/fast-model",
      "auth": { "authToken": "replace-with-local-credential" }
    }
  ]
}
```

Each profile requires an id, label, endpoint, main model, fast model and exactly
one credential: `apiKey` maps to `ANTHROPIC_API_KEY`, or `authToken` maps to
`ANTHROPIC_AUTH_TOKEN`. URLs require HTTPS, except HTTP on loopback for local
gateways. URL credentials, query strings and fragments are rejected. Profile ids
are 1–64 letters, digits, underscores or hyphens, starting with a letter/digit.
The file allows at most 50 profiles and 1 MiB.

Test a single profile with:

```sh
npx cumora@latest agent computer --doctor --provider work
```

This runs Claude's main, small and wake-path probes using that profile. It makes
real model requests. It does not probe other engines or the computer's default
account. The daemon must be upgraded to a build containing provider support;
older releases do not understand these options.

The daemon advertises profile ids, labels and model defaults on its next engine
scan. Use the computer's engine refresh control to request an immediate scan.
In the Agent editor, select the paired computer, Claude, then the provider.
Credentials and endpoint URLs stay local; the participant row stores only the
profile id. Profiles are scoped to a computer, so moving an Agent requires a
fresh selection.

## Runtime behavior

- Each runner receives its own environment snapshot. Main turns, persistent
  sessions and small-brain triage all use the selected profile. The process-wide
  environment is never modified.
- Explicit Agent model pins override the profile's model defaults. Computer and
  deployment model defaults apply only when no profile is selected. Model pins
  are cleared in the editor when switching providers, engines or computers.
- Profile environments clear inherited Claude provider credentials, OAuth
  tokens, provider-selection flags and model aliases. Secure mode still denies
  credentials to model-spawned tools. Unsandboxed compatibility mode cannot run
  or advertise profiles.
- A profile is reread on Agent synchronization. Changed runtime configuration
  stops the previous runner and waits for its engine to terminate before starting
  the replacement. An in-progress turn can be interrupted; it is not retried as
  part of the configuration switch.
- Native session pointers are separated by a local digest of the profile id,
  endpoint, credentials and model defaults. Changing these values starts a new
  native session; returning to an unchanged profile may resume that profile's
  earlier session. Agent files, memory and Cumora conversation history persist
  and can still be included in future prompts.
- If the file becomes invalid, unreadable or disappears, a bound Agent stops on
  the next successful synchronization. A missing profile or unavailable Claude
  never falls back to another provider or engine. Other Agents using the
  computer default continue normally. Diagnostics appear in the daemon log.

## Deployment and compatibility

Apply migration `0007_agent_provider_profile` before starting this server build.
Existing participants have a null profile and retain their current behavior.
The migration also rotates runtime assignment tokens when the profile changes.

New daemons request profile-aware discovery and include their selected profile
when requesting runtime tokens. Older daemons cannot discover profile-bound
Agents or mint replacement tokens for them. Switching profiles invalidates the
old runner's authorization. This does not undo tool actions already completed
before the switch, or erase a request already sent to a provider.

The first version does not synchronize credentials through Cumora, manage them
in the browser, probe gateway model catalogs, or implement provider failover.
It uses Claude Code's existing secure execution requirements and supports
gateways compatible with the Claude Code request protocol.
