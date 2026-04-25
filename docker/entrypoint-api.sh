#!/bin/sh
set -e

npx prisma migrate deploy --schema packages/db/prisma/schema.prisma
node apps/api/dist/index.js
