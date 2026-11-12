# GoBox · Consulta de pacotes

Site da GoBox para o cliente conferir se o pacote dele já está na agência, e um painel administrativo protegido para manter a base atualizada a partir de **Shopee SPX**, **Mercado Livre Places** e **Correios**.

- Cliente: digita o código e vê só **"Pacote encontrado."** ou **"Pacote não encontrado."**
- Administrador: vê os pacotes por empresa, a situação de cada fonte e importa os relatórios.

---

## Como os dados chegam

Há três caminhos, que podem ser usados juntos:

| Caminho | Empresas | Como funciona |
|---|---|---|
| **Extensão do Edge (automático, recomendado)** | Shopee SPX e Mercado Livre Places | Você abre os portais no seu Edge, como já faz todo dia. A extensão lê a lista de pacotes da agência nessas abas (com o seu login) a cada 10 min e envia só os códigos para o site. Instalação e uso: `extensao-edge/COMO-INSTALAR.txt`. |
| **Robô (alternativa)** | Shopee SPX e Mercado Livre Places | A cada `ROBO_INTERVALO_MINUTOS` (padrão 10 min), o robô abre um Microsoft Edge **com perfil próprio**, já logado por você, e lê a lista de pacotes que estão na agência. É a mesma lista que o portal mostra na tela. |
| **Envio pelo painel** | Todas | Botão *Importar relatório* → prévia → **Confirmar**. |
| **Pasta de entrada** | Todas | Arquivo em `data/entrada/<empresa>/` é importado sozinho. |

### Extensão e robô: o que eles leem
- **Shopee SPX:** *Drop-off* na aba "DOP Received" (recebido do vendedor e ainda não saiu) e *Self-Collection* na aba "Ready For Collection" (aguardando o comprador). Antes de ler, o robô seleciona o ponto da agência, porque o portal às vezes volta sozinho para o ponto "Admin", onde as listas ficam vazias. Se a conta tiver mais de um ponto além do Admin, defina `SHOPEE_PONTO_ID`.
- **Mercado Livre Places:** a tela "Estoque na sua agência".
- **Correios Atende:** ainda **não** tem robô. Use a importação de relatório.

Só o **código** de cada pacote é guardado. Nome, telefone e o resto são descartados na leitura.

### Robô: login e sessão
- Na primeira vez, o `iniciar.bat` abre a janela **"entrar nos portais"**. Faça login na Shopee e no Mercado Livre e **feche a janela**.
- O sistema nunca vê nem guarda a sua senha. A sessão fica no perfil do navegador do robô (`data/robo-perfil`).
- Quando a sessão expirar, o painel mostra **"Falhou — sessão expirada"** naquela empresa. Abra `entrar-nos-portais.bat`, entre de novo e feche a janela. A outra empresa continua funcionando normalmente.
- Se uma leitura vier muito menor que a anterior (ex.: falha do portal), ela **não apaga** a consulta. Fica em *Importações* aguardando sua confirmação.

### Riscos que você aceitou
- Os endereços que o robô lê são os que o próprio site do portal usa, **não uma API oficial**. Isso **pode ir contra os termos de uso** das empresas, com risco de bloqueio da conta, e o robô **para de funcionar** se o portal mudar. Quando isso acontecer, o painel avisa e a importação manual continua disponível.
- O robô só funciona com o **computador ligado** e o site rodando (`iniciar.bat`). Num servidor na nuvem não há Edge logado; por isso, nesse caso, deixe `ROBO_ATIVO=false`.

**Frequência real:** a consulta é tão atual quanto a última passada do robô ou a última importação. Não é tempo real. O painel mostra a hora da última atualização de cada empresa e marca como *Desatualizado* depois de X horas.

## Instalação

Requisitos: **Node.js 22.13 ou mais novo** (o banco de dados já vem embutido no Node; nada precisa ser compilado).

```bash
npm install
cp .env.example .env
npm run senha          # digite a senha do admin; copie a linha ADMIN_PASSWORD_HASH=... para o .env
```

Edite o `.env` e preencha pelo menos `ADMIN_USER` e `ADMIN_PASSWORD_HASH`.

### Rodar no seu computador (teste)
No `.env`, use `NODE_ENV=development`, `COOKIE_SECURE=false` e `TRUST_PROXY=false`. Depois:

```bash
npm start
```

- Consulta pública: http://localhost:3000
- Painel: http://localhost:3000/admin/

### Colocar no ar
Qualquer servidor que rode Node e mantenha arquivos em disco serve, como uma VPS (com Nginx na frente) ou Render/Railway com **disco persistente** montado em `data/`.

1. Envie o projeto **sem** o `.env` e sem a pasta `data/` (o `.gitignore` já impede isso no Git).
2. Configure as variáveis do `.env.example` no painel de variáveis/segredos do serviço, ou crie o `.env` direto no servidor.
3. Use **HTTPS** e deixe `COOKIE_SECURE=true` e `TRUST_PROXY=true`.
4. Comando de início: `npm start`.
5. Faça backup periódico de `data/gobox.sqlite`.

---

## Primeiro uso (passo a passo)

1. Entre em `/admin/` com o usuário e a senha que você configurou.
2. No portal de cada empresa, exporte o relatório de pacotes (CSV ou XLSX).
3. No painel, clique em **Importar relatório**, escolha a empresa e o arquivo e clique em **Ler arquivo**.
4. Se aparecer *"Não encontrei uma coluna de código reconhecida"*, a mensagem lista os cabeçalhos do arquivo. Vá em **Configurações** e escreva no campo *Nome da coluna com o código* o nome exato da coluna que tem o código de rastreio. Salve e importe de novo.
5. Confira a prévia e clique em **Confirmar importação**.
6. Teste na página pública com um código que estava no relatório.

### Configurações por empresa (no painel)
- **Nome da coluna com o código**: o cabeçalho da coluna de rastreio no relatório. Em branco, o sistema tenta reconhecer sozinho.
- **Coluna com o ID da fonte** (opcional): um identificador extra da empresa, exibido só no painel.
- **Tipo de relatório**
  - *Relatório completo* (padrão): o arquivo representa tudo o que está na agência naquele momento. Quem não aparece mais sai da consulta, sem ser apagado do histórico.
  - *Só adicionar*: nunca remove nada. Use se o relatório trouxer só os pacotes novos.
- **Considerar desatualizado após (horas)**
- **Limite de remoção da pasta de entrada (%)**

---

## Regras da consulta pública

- **Normalização:** retira espaços e caracteres invisíveis do começo e do fim e converte letras para maiúsculas. Nenhum outro caractere é alterado. A mesma regra vale na importação e na consulta.
- **Correspondência exata:** um código parecido ou incompleto retorna "Pacote não encontrado.", sem dar pista de que existe algo próximo.
- A resposta é só `{"encontrado": true}` ou `{"encontrado": false}`: sem empresa, status, nomes ou listas.
- **Limite de consultas:** 20 por minuto por IP (`PUBLIC_RATE_PER_MINUTE`). Acima disso, aparece uma mensagem pedindo para aguardar.
- O código vai no corpo da requisição (POST), não na URL. Por isso não aparece em históricos ou registros de acesso.

## Segurança e dados pessoais

- A senha do admin fica só como hash bcrypt no servidor. A sessão usa cookie `HttpOnly` + `SameSite=Strict` (+ `Secure` em produção), e as ações do painel conferem a origem da requisição.
- O login tem limite de 10 tentativas a cada 15 minutos.
- Dos relatórios, o sistema guarda **somente o código e o ID da fonte**. Nome, telefone, endereço e qualquer outra coluna são descartados na leitura. Arquivos da pasta de entrada são **apagados** depois de lidos.
- Se um arquivo falhar porque não tem cabeçalho reconhecido, os cabeçalhos aparecem **só na tela** de quem enviou. Eles não vão para o histórico, porque um arquivo sem cabeçalho teria dados de cliente na primeira linha.
- Erros internos aparecem para o cliente como mensagem genérica. O detalhe vai só para o registro do servidor.
- Nenhuma credencial dos portais (Shopee, Mercado Livre, Correios) é usada ou armazenada.
- Cabeçalhos de segurança (CSP, sem iframes de outros sites) via `helmet`.

## Contabilidade (aba do painel)

- **Contracheques quinzenais:** funcionários e horas extras vêm do Ponto GoBox, com as mesmas regras do relatório do ponto (extras 50%, 100% em domingos e feriados, tolerância). O salário de cada funcionário fica na Contabilidade. Tudo pode ser alterado por quinzena: valor da quinzena, horas, adicional, proventos e descontos. O recibo sai pronto para imprimir ou salvar em PDF.
- **Notas fiscais:** Correios e Shopee mensais, Mercado Livre quinzenal. O valor sugerido vem do Financeiro. O dia do pagamento é previsto pelo histórico de cada empresa (dias corridos, dias úteis ou dia fixo do mês, o que for mais regular); com menos de 3 pagamentos registrados, vale o prazo informado no modelo de emissão.
- **Modelo de emissão por empresa:** tomador, CNPJ, código de serviço, CNAE, descrição, observações obrigatórias (hashtags, códigos), quando emitir e onde enviar. Cada nota gera um documento de emissão com esses dados preenchidos, que fica salvo com a nota.
- Os dados ficam na tabela `financeiro` (chaves `contab:*`), salva no Firebase junto com o resto.
- **Para tirar a aba:** desfazer o commit da Contabilidade (reverter o commit "Contabilidade" no ramo `consulta` do repositório ponto-gobox, que é o que o Render publica). As chaves `contab:*` que sobrarem no banco não afetam nada.

## Testes

```bash
npm test
```

Os testes cobrem os critérios de aceitação: respostas públicas, correspondência exata, ausência de dados pessoais, login, duplicatas, sincronização independente por fonte, confirmação de remoções e limite de consultas.

## Estrutura

```
src/
  server.js      inicia o servidor e o agendador da pasta de entrada
  app.js         rotas da consulta pública e do painel
  config.js      lê as variáveis de ambiente
  db.js          banco SQLite (pacotes, importações, configurações, sessões)
  sources.js     regras de cada empresa (colunas reconhecidas, padrões)
  parse.js       leitura de CSV/XLSX
  importer.js    prévia, confirmação e aplicação das importações
  inbox.js       pasta de entrada monitorada
  normalize.js   normalização do código
  auth.js        login e sessão do administrador
public/          página pública e painel (HTML, CSS, JS)
scripts/gerar-hash-senha.js
test/app.test.js
```

## Limitações conhecidas

- **Robô não oficial (Shopee e Mercado Livre):** veja "Riscos que você aceitou" acima.
- **Correios sem robô:** o Correios Atende é o sistema de caixa da agência e não tem uma lista de "pacotes na agência" que o robô consiga ler. Por enquanto, use a importação de relatório.
- **Formato dos relatórios não confirmado.** As colunas reconhecidas automaticamente são palpites, porque os portais não documentam publicamente seus relatórios. Confirme a coluna certa em Configurações na primeira importação de cada empresa.
- **Códigos muito longos em XLSX.** Números com mais de 15 dígitos digitados como número no Excel perdem precisão, por limitação da própria planilha. Se o portal exportar códigos assim, prefira CSV.
- **Um único administrador.** Não há papéis diferentes. Se precisar de mais de um acesso (ex.: atendente só consulta, gerente importa), dá para adicionar.
- A dependência `exceljs` tem um alerta moderado de segurança numa biblioteca usada só para **gerar** arquivos ZIP, função que o sistema não usa.
