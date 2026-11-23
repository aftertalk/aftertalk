import pydantic_ai

# The CLI prints JSON on stdout; PydanticAI's first-run banner must not land in it.
pydantic_ai.BANNER_ENABLED = False
