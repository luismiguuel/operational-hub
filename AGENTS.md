# Regras do CITi Hub

## Identidade visual e UI/UX (`apps/web`)
Antes de criar ou editar qualquer tela, modal, componente ou estilo no frontend, leia integralmente e siga:

- `.agents/skills/citi-visual-language/SKILL.md`
- `.agents/skills/citi-visual-language/assets/tokens.css`
- `.agents/skills/citi-visual-language/references/visual-audit.md`

O produto usa exclusivamente Dark Mode em tons de verde CITi. Fundos brancos ou cinza-claros são proibidos; use os tokens semânticos definidos na skill.

## Regras de Git

- Trabalhe exclusivamente por branches no diretório raiz do repositório. `git worktree` é proibido.
- Faça commits pequenos, atômicos e frequentes, cada um com uma responsabilidade lógica.
- Use Conventional Commits estritamente sem emojis.

## Validação

Antes de concluir uma entrega, rode `pnpm typecheck`, `pnpm lint`, `pnpm format:check` e `pnpm build` usando Node.js 22 ou superior.
