# Samples

Polish test calls for the name-recall check (spike Q1, release gate) and,
later, the "Process the sample call" button (item 10a).

Each folder holds:

- `script.json`: the call's script, turn by turn (agent on the left channel,
  customer on the right).
- `labels.json`: the personal data in the script, marked by hand, with
  character offsets into each turn. `person` labels are the name-recall set.
- `consent.md`: where the call comes from and what allows it to be here
  (signed consent for a recorded call; for a generated call, the ElevenLabs
  plan and the generation date, #18).

| Folder | Kind | Turns | Names |
| --- | --- | --- | --- |
| `el-01-internet-awaria` | ElevenLabs, ISP fault report | 22 | 2 |
| `el-02-fotowoltaika-sprzedaz` | ElevenLabs, pushy solar sales call | 22 | 1 |
| `el-03-szkoda-komunikacyjna` | ElevenLabs, car insurance claim | 25 | 4 |

Not here yet: the audio files, and the role-played call recorded by the team
(`pl-roleplay`). Both wait for the gates of item 10: signed consent on file
for the recording, and a confirmed ElevenLabs licence for redistribution.
