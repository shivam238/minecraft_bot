#!/bin/bash
# Minecraft Bot Automated Git Push Script

set -e

GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${BLUE}===================================================${NC}"
echo -e "${BLUE}           MINECRAFT BOT GIT PUSH SCRIPT           ${NC}"
echo -e "${BLUE}===================================================${NC}"

# Ask for commit message
COMMIT_MSG="$1"

if [ -z "$COMMIT_MSG" ]; then
    read -rp "Commit message (Enter = default): " input
    COMMIT_MSG="${input:-update: bot improvements}"
fi

# Ensure git credential helper is stored
git config credential.helper store

# Add all changed files
echo -e "\n${BLUE}[1/3] Staging changes...${NC}"
git add .

# Check if there are any changes to commit
if git diff --cached --quiet
then
    echo -e "${YELLOW}[2/3] Nothing new to commit.${NC}"
else
    echo -e "${GREEN}[2/3] Committing changes...${NC}"
    git commit -m "$COMMIT_MSG"
fi

# Push to origin
echo -e "\n${BLUE}[3/3] Pushing to GitHub...${NC}"
CURRENT_BRANCH=$(git branch --show-current)
git push origin "$CURRENT_BRANCH"

echo
echo -e "${GREEN}===================================================${NC}"
echo -e "${GREEN}          CODE PUSHED SUCCESSFULLY!                ${NC}"
echo -e "${GREEN}===================================================${NC}"
