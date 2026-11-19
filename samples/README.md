# Samples

Test calls for the name-recall check (spike Q1, release gate) and, later, the
"Process the sample call" button (item 10a). English calls come first (#90);
the Polish calls cover the same three topics. The release gate's name recall
is measured on the Polish `person` labels; the English labels are used for
English redaction checks.

Each folder holds:

- `script.json`: the call's script, turn by turn (agent on the left channel,
  customer on the right), with its `language`.
- `labels.json`: the personal data in the script, marked by hand, with
  character offsets into each turn. `person` labels are the name-recall set.
- `consent.md`: where the call comes from and what allows it to be here
  (signed consent for a recorded call; for a generated call, the ElevenLabs
  plan and the generation date, #18).

| Folder | Language | Kind | Turns | People named |
| --- | --- | --- | --- | --- |
| `el-en-01-broadband-outage` | English | ElevenLabs, ISP fault report | 22 | 2 |
| `el-en-02-solar-sales` | English | ElevenLabs, pushy solar sales call | 22 | 2 |
| `el-en-03-car-insurance-claim` | English | ElevenLabs, car insurance claim | 25 | 4 |
| `el-01-internet-awaria` | Polish | ElevenLabs, ISP fault report | 22 | 2 |
| `el-02-fotowoltaika-sprzedaz` | Polish | ElevenLabs, pushy solar sales call | 22 | 1 |
| `el-03-szkoda-komunikacyjna` | Polish | ElevenLabs, car insurance claim | 25 | 3 |

Not here yet: the audio files, and the role-played call recorded by the team
(`pl-roleplay`). Both wait for the gates of item 10: signed consent on file
for the recording, and a confirmed ElevenLabs licence for redistribution. The
English calls are scripts only so far; their audio is generated after that
licence gate.
