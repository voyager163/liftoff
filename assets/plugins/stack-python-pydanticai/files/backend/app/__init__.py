"""{{liftoff.name}}: a GenAI API built with FastAPI and PydanticAI."""

import os

# PydanticAI prints a banner on first use unless tracing is set up. The API's
# logs are not the place for it.
os.environ.setdefault("PYDANTIC_AI_NO_BANNER", "1")
