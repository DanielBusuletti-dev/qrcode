FROM node:20-alpine

WORKDIR /app

# Copia manifestos primeiro para cachear dependências
COPY package.json package-lock.json* ./

RUN npm ci --omit=dev

# Copia o restante do código
COPY src ./src
COPY README.md ./

ENV NODE_ENV=production \
    AUTH_DIR=/data/auth \
    PORT=3000

# Diretório de autenticação persistente
VOLUME ["/data/auth"]

EXPOSE 3000

CMD ["npm", "start"]

