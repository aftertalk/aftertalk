# pii

Personal-data redaction. `rules/` holds the pattern rules (PESEL, NIP, IBAN, ID
card, phone, postal code, REGON) without Presidio, `names.py` the GLiNER name
detector, `redact.py` the step that merges both into word ranges with numbered
tokens such as `[PERSON_1]`. Spec: items 70-72.
