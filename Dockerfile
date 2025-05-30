FROM node:24-alpine AS builder

RUN mkdir -p /opt/autoupdate/dist

WORKDIR /opt/autoupdate

COPY . /opt/autoupdate/

RUN corepack enable

RUN yarn install --frozen-lockfile && yarn run build

FROM node:24-alpine AS runner

LABEL com.github.actions.name="Auto-update pull requests with changes from their base branch"
LABEL com.github.actions.description="A GitHub Action that auto-updates PRs with changes from their base branch"
LABEL com.github.actions.icon="git-pull-request"
LABEL com.github.actions.color="blue"

RUN apk add --update --no-cache ca-certificates \
  && mkdir -p /opt/autoupdate

WORKDIR /opt/autoupdate

COPY --from=builder /opt/autoupdate/dist/index.js /opt/autoupdate/index.js

ENTRYPOINT [ "node", "/opt/autoupdate/index.js" ]
