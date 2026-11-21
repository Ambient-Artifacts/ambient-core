# Fixtures

Synthetic wikis used by tests on both sides (TypeScript store, Swift BrainCore).
All people, companies and conversations here are invented. Never put real
meeting content or real names in this folder.

- `wiki-personal/`: what a phone syncs to the personal store (`wiki/**`, scope personal).
- `wiki-team/`: a team VPS wiki (team `t_acme`, slug `acme`).

## `transcript/`

The transcript file a team's destination receives (`renderTranscript` and `destinationFileName` in `spec/src/transcript.ts`). The app writes the same file when it saves a team recording into a folder on the device. `kickoff.json` holds the input (`meta`, `segments`) and the expected file name (`file`); `kickoff.md` is the exact file, byte for byte. Both implementations are tested against them.
