FROM node:26-alpine

WORKDIR /app

# No dependencies: package.json is copied for metadata only.
COPY package.json ./
COPY server.js ./
COPY lib/ ./lib/
COPY public/ ./public/
COPY data/ ./data/

ENV PORT=8531
ENV HOST=0.0.0.0
EXPOSE 8531

USER node

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8531)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
