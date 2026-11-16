---
name: citi-visual-language
description: Diretrizes de identidade visual do CITi (citi.org.br) traduzidas para um Hub Operacional SaaS estilo Linear/Jira. Use ao criar ou refatorar telas, componentes, tokens, tabelas e quadros Kanban do sistema interno.
---

# CITi Visual Language — Guia de Tradução para Produto SaaS

Esta skill traduz a linguagem visual institucional observada em [citi.org.br](https://citi.org.br/) e [citi.org.br/cases/neoenergia](https://citi.org.br/cases/neoenergia) (rigor técnico do CIn-UFPE, contraste dark/light, verde vibrante de marca e geometria limpa) para uma interface operacional densa de gestão de projetos.

> Sempre importe `assets/tokens.css` na raiz da aplicação antes de estilizar componentes.

---

## 1. Tipografia e Escala

### Importação (Google Fonts)
Adicione ao `<head>` do `index.html` (ou importe no CSS global):

```html
<link rel="preconnect" href="[https://fonts.googleapis.com](https://fonts.googleapis.com)" />
<link rel="preconnect" href="[https://fonts.gstatic.com](https://fonts.gstatic.com)" crossorigin />
<link
  href="[https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&family=Plus+Jakarta+Sans:ital,wght@0,400;0,500;0,600;0,700;1,400;1,600&display=swap](https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&family=Plus+Jakarta+Sans:ital,wght@0,400;0,500;0,600;0,700;1,400;1,600&display=swap)"
  rel="stylesheet"
/>

## Tema obrigatório: 100% Dark Mode

O produto usa um tema escuro único em todas as telas. `tokens.css` é a fonte de verdade: canvas obsidiana `#080C0A`, sidebar floresta `#0B110E`, superfícies verdes escuras e texto claro. Use o verde CITi `--accent-primary` para CTAs, foco e estados ativos; texto sobre o botão usa `--accent-foreground`. Itens selecionados usam `--accent-surface` e `--accent-border`. Preserve contraste e use os tokens semânticos de status, prioridade e área.

Fundos brancos ou cinza-claros são proibidos: não use `bg-white`, `bg-gray-50`, `bg-slate-50` nem equivalentes CSS. Inputs usam `--bg-sidebar`/`--bg-surface`, borda `--border-strong` e foco verde. A sidebar e o workspace compartilham a hierarquia dark; diferenciam-se por elevação e subtom, nunca por uma tela clara.
