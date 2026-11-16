# Visual Audit Checklist — CITi Operational Hub

Execute esta auditoria em **cada tela ou componente novo/refatorado** antes do commit. Nenhum PR de UI deve ser aprovado com falhas nos itens críticos (`[WCAG]` e `[Tokens]`).

---

## 1. Contraste e Tokens (`[WCAG]` / `[Tokens]`)
- [ ] **Zero valores hardcoded**: todas as cores, raios e fontes vêm de `tokens.css` (nenhum `#hex` ou `rgb()` solto no JSX/CSS do componente).
- [ ] **Contraste de texto WCAG AA**: texto normal e de tabela atinge `>= 4.5:1`; ícones funcionais e bordas de input atingem `>= 3:1`.
- [ ] **Proteção do verde CITi**: nenhum texto, link ou ícone fino usa `#2ee66b` (`--accent-primary`) diretamente sobre fundo claro (`#ffffff` ou `#f7f8f7`); nesses casos, usa `--accent-text-on-light` (`#0f7634`).
- [ ] **Botão primário legível**: botões com fundo `--accent-primary` usam texto escuro (`--accent-foreground`), nunca texto branco.
- [ ] **Status, Prioridade e Áreas**: badges usam os tokens semânticos (`--status-*`, `--priority-*`, `--area-*`) com fundo suave + borda `1px` + texto de alto contraste.

## 2. Tipografia e Alinhamento Numérico
- [ ] **Hierarquia correta**: títulos com `--font-sans` e tracking fechado (`--tracking-tight`); IDs (`ELO-xxx`), micro-labels (`01 / SPRINT`) e códigos usam `--font-mono` em uppercase com `--tracking-wide`.
- [ ] **Tabular nums**: KPIs, contadores de colunas Kanban, datas, percentuais e colunas numéricas de tabelas aplicam `font-variant-numeric: tabular-nums`.
- [ ] **Truncamento seguro**: títulos longos de cards e células de tabela possuem `truncate` (`text-overflow: ellipsis`) ou quebra controlada sem estourar o grid.

## 3. Grid, Espaçamento e Geometria
- [ ] **Hairline-first**: cards, inputs e divisores usam bordas `1px solid` (`--border-subtle` / `--border-strong`), sem sombras projetadas em elementos em repouso.
- [ ] **Raios consistentes**:
  - Botões CTA e badges/tags em pill (`9999px`).
  - Cards e painéis em `12px` (`--radius-card`).
  - Inputs e selects em `8px` (`--radius-input`).
- [ ] **Alinhamento de grid**: colunas do Kanban, cabeçalhos de tabela e barra superior obedecem a múltiplos consistentes de `4px`/`8px` sem desalinhamento de baseline entre ícone e texto.
- [ ] **Zero poluição visual**: sem gradientes em botões/tabelas e sem emojis em headers ou status.

## 4. Estados de Interface (Loading, Vazio, Erro, Interação)
- [ ] **Estado de Loading**: skeletons respeitam o layout real (altura de linha, raio de borda do card/pill) com transição sutil, sem layout shift brusco.
- [ ] **Estado Vazio (Empty State)**: informa claramente o motivo e oferece 1 ação primária (botão pill) ou atalho de teclado, sem ilustrações genéricas desconectadas da marca.
- [ ] **Estado de Erro**: exibe mensagem objetiva com ação de recuperação (`Tentar novamente`) usando tokens de erro de alto contraste.
- [ ] **Hover e Active**: linhas de tabela, cards clicáveis e itens da sidebar têm feedback visual claro (`--bg-surface-hover` / `--bg-sidebar-hover` ou `--border-strong`).

## 5. Acessibilidade e Foco de Teclado
- [ ] **Focus-visible visível**: todo elemento interativo (botões, links, inputs, cards arrastáveis, itens de menu) exibe `--focus-ring` (ou `--focus-ring-dark` na sidebar) ao navegar via `Tab`.
- [ ] **Navegação por teclado**: modais, dropdowns e command bar abrem, navegam (`ArrowUp`/`ArrowDown`) e fecham (`Esc`) pelo teclado.
- [ ] **Labels e ARIA**: botões apenas com ícone possuem `aria-label`; inputs possuem `<label>` associado e mensagens de erro vinculadas.

## 6. Responsividade e Densidade
- [ ] **Desktop denso (`>= 1280px`)**: sidebar fixa + workspace fluido sem barra de rolagem horizontal indesejada na página inteira (scroll horizontal restrito ao container do Kanban quando houver muitas colunas).
- [ ] **Tablet / Mobile (`< 1024px`)**: sidebar colapsa em drawer acessível por botão com `aria-label`; tabelas largas têm scroll horizontal contido e colunas prioritárias visíveis; alvos de toque têm no mínimo `36px`–`40px` de altura.