@echo off
set "LLM_PROVIDER=openai"
set "LLM_MODEL=gpt-6-luna"
set "LLM_BASE_URL=https://api.openai.com/v1"
cd /d "D:\gitlocals\kanli8-human\capybara-github\capybara"
npm run desktop:start --workspace=apps/workbench
