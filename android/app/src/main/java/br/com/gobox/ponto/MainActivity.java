package br.com.gobox.ponto;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.view.WindowManager;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

/** Abre a tela de ponto da GoBox em tela cheia, com a tela sempre ligada. */
public class MainActivity extends Activity {
    private WebView web;
    private String appUrl;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        getWindow().setStatusBarColor(Color.parseColor("#333366"));
        appUrl = getString(R.string.app_url);

        web = new WebView(this);
        web.setBackgroundColor(Color.WHITE);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setMediaPlaybackRequiresUserGesture(true);

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri u = request.getUrl();
                Uri base = Uri.parse(appUrl);
                if (u.getHost() != null && u.getHost().equals(base.getHost())) return false;
                try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (Exception ignored) { }
                return true;
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) showOffline();
            }
        });

        setContentView(web);
        if (savedInstanceState != null) web.restoreState(savedInstanceState);
        else web.loadUrl(appUrl);
    }

    private void showOffline() {
        String html = "<!doctype html><html><head><meta name='viewport' content='width=device-width,initial-scale=1'>"
            + "<style>body{font-family:sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;"
            + "height:100vh;margin:0;padding:24px;box-sizing:border-box;text-align:center;color:#24244A}"
            + "h1{font-size:24px}a{display:inline-block;margin-top:16px;background:#333366;color:#fff;padding:16px 28px;"
            + "border-radius:14px;text-decoration:none;font-size:18px;font-weight:600}</style></head><body>"
            + "<h1>Sem conexão</h1><p>Não foi possível abrir o ponto. Verifique o Wi-Fi ou os dados móveis do celular.</p>"
            + "<a href='" + appUrl + "'>Tentar de novo</a></body></html>";
        web.loadDataWithBaseURL(null, html, "text/html", "utf-8", null);
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        web.saveState(outState);
    }

    @Override
    public void onBackPressed() {
        // Terminal de ponto: o botão voltar não fecha o app.
        if (web.canGoBack()) web.goBack();
    }
}
