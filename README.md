# Ponto GoBox

Controle de ponto da GoBox.

- **Painel do administrador** (computador, navegador): `index.html` — equipe, códigos, horas extras, relatórios, ajustes e acessos.
- **Tela de ponto** (celular da agência): `ponto.html`, empacotada no app Android `ponto-gobox.apk`. Os funcionários digitam o código de 4 números.

Dados e logins ficam no Firebase (Firestore + Authentication). As regras de segurança estão em `firestore.rules`.

A cada envio para a branch `main`, o GitHub Actions gera o APK e publica o site no GitHub Pages.
