GB GESTAO DE PEDIDOS — VERSAO 3.11.1 (RENDER)

ESTE APLICATIVO E SEPARADO DO CENTRAL JB AUTO PECAS.
Crie um NOVO Web Service para este repositório. Nunca substitua o serviço antigo.

CONFIGURACAO DO WEB SERVICE
- Language: Node
- Branch: main
- Build Command: npm install
- Start Command: npm start
- Root Directory: deixe em branco
- Região: Oregon (ou a mesma região do outro serviço)

ARMAZENAMENTO — MUITO IMPORTANTE
O sistema grava tokens, configurações, fila e dados locais em arquivos JSON.
Para manter esses dados após reinícios e novos deploys, é NECESSÁRIO um Persistent Disk.
No Render, o plano Free não oferece Persistent Disk.
Use uma instância compatível com Persistent Disk e configure:
- Persistent Disk Mount Path: /var/data
- Environment Variable: DATA_DIR=/var/data

Sem Persistent Disk, não conecte Shopee/Bling nem use pedidos reais: os arquivos gravados no disco temporário podem ser perdidos.

VARIAVEIS DE AMBIENTE
Configure no Render (não coloque segredos no GitHub):
- DATA_DIR=/var/data
- BLING_CLIENT_ID
- BLING_CLIENT_SECRET
- BLING_REDIRECT_URI=https://URL-DO-NOVO-GB.onrender.com/oauth/bling/callback
- SHOPEE_PARTNER_ID=2042612
- SHOPEE_PARTNER_KEY
- SHOPEE_REDIRECT_URI=https://URL-DO-NOVO-GB.onrender.com/shopee/callback
- APP_SECRET (gere uma chave longa, aleatória e mantenha-a estável)
- ENABLE_SEND_NFE=false

CALLBACKS
Depois de criar o serviço e conhecer sua URL pública:
1. Cadastre o BLING_REDIRECT_URI no aplicativo do Bling.
2. Cadastre o SHOPEE_REDIRECT_URI no aplicativo da Shopee.
3. Autorize Bling e Shopee pela URL pública do NOVO GB.
Não use a URL do Central JB Auto Peças e não use localhost nos callbacks de produção.

SEGURANCA
- Não compartilhe Partner Key, Client Secret, APP_SECRET ou tokens.
- Não envie prints contendo códigos OAuth ou URLs com ?code=.
- ENABLE_SEND_NFE deve permanecer false até que a operação fiscal seja validada.
- O pacote não contém credenciais nem tokens.

ALTERACAO 3.11.1
A função de gravação agora cria o diretório DATA_DIR automaticamente antes de salvar store.json.
Isso evita erro quando o diretório ainda não existe; não substitui o Persistent Disk.


Correção 3.11.3: classificação de Entrega Direta com variações de nome da logística do vendedor; modalidades desconhecidas não são mais presumidas como envio normal.
