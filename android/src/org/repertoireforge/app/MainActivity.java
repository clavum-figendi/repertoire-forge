package org.repertoireforge.app;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.util.Base64;
import android.webkit.*;
import android.widget.Toast;
import java.io.*;
import java.util.*;

/** Bundled HTTPS origin; network allowed only for public chess APIs. */
public class MainActivity extends Activity {
    private static final String HOST = "appassets.androidplatform.net";
    private static final String CLOUD_HOST = "repertoire-forge-cloud.clavum-figendi.workers.dev";
    private WebView web;
    private ValueCallback<Uri[]> fileCallback;
    private byte[] pendingExport;
    private String pendingName, pendingMime;
    private WebResourceResponse local(Uri uri) {
        String path = uri.getPath();
        if (path == null || path.contains("..") || path.contains("\\")) return denied();
        if (path.equals("/")) path = "/index.html";
        String mime = path.endsWith(".js") ? "application/javascript" : path.endsWith(".wasm") ? "application/wasm" : path.endsWith(".css") ? "text/css" : path.endsWith(".json") || path.endsWith(".webmanifest") ? "application/json" : path.endsWith(".svg") ? "image/svg+xml" : "text/html";
        try {
            Map<String,String> headers = new HashMap<>();
            headers.put("Access-Control-Allow-Origin", "https://" + HOST);
            headers.put("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; worker-src 'self' blob:; connect-src 'self' https://explorer.lichess.ovh https://lichess.org https://api.chess.com https://" + CLOUD_HOST + "; object-src 'none'; base-uri 'self'");
            return new WebResourceResponse(mime, "UTF-8", 200, "OK", headers, getAssets().open("web" + path));
        } catch (IOException e) { return denied(); }
    }
    private static WebResourceResponse denied() { return new WebResourceResponse("text/plain", "UTF-8", 403, "Forbidden", Collections.emptyMap(), new ByteArrayInputStream(new byte[0])); }
    private boolean api(Uri uri) { return "https".equals(uri.getScheme()) && Arrays.asList("explorer.lichess.ovh", "lichess.org", "api.chess.com", CLOUD_HOST).contains(uri.getHost()); }
    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().setStatusBarColor(0xffedf0e8);
        web = new WebView(this);
        WebView.setWebContentsDebuggingEnabled(false);
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true); settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false); settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setSupportMultipleWindows(false);
        web.addJavascriptInterface(new ExportBridge(), "Android");
        web.setWebViewClient(new WebViewClient() {
            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                Uri uri=request.getUrl();
                if (HOST.equals(uri.getHost()) && "https".equals(uri.getScheme())) return local(uri);
                return api(uri) ? null : denied();
            }
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                if (HOST.equals(request.getUrl().getHost()) && "https".equals(request.getUrl().getScheme())) return false;
                if (request.isForMainFrame() && "https".equals(request.getUrl().getScheme())) {
                    try { startActivity(new Intent(Intent.ACTION_VIEW, request.getUrl())); } catch (Exception ignored) {}
                }
                return true;
            }
        });
        if (android.os.Build.VERSION.SDK_INT >= 24) {
            ServiceWorkerController.getInstance().setServiceWorkerClient(new ServiceWorkerClient() {
                @Override public WebResourceResponse shouldInterceptRequest(WebResourceRequest request) {
                    Uri uri=request.getUrl();return HOST.equals(uri.getHost()) ? local(uri) : api(uri) ? null : denied();
                }
            });
        }
        web.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback=callback;
                Intent intent=new Intent(Intent.ACTION_OPEN_DOCUMENT);intent.setType("*/*");intent.addCategory(Intent.CATEGORY_OPENABLE);
                try {startActivityForResult(intent,100);}catch(Exception e){fileCallback.onReceiveValue(null);fileCallback=null;return false;}return true;
            }
            @Override public boolean onJsAlert(WebView view,String url,String message,JsResult result){new AlertDialog.Builder(MainActivity.this).setMessage(message).setPositiveButton("OK",(d,w)->result.confirm()).setOnCancelListener(d->result.cancel()).show();return true;}
            @Override public boolean onJsConfirm(WebView view,String url,String message,JsResult result){new AlertDialog.Builder(MainActivity.this).setMessage(message).setPositiveButton("Continue",(d,w)->result.confirm()).setNegativeButton("Cancel",(d,w)->result.cancel()).setOnCancelListener(d->result.cancel()).show();return true;}
        });
        setContentView(web);
        web.loadUrl("https://"+HOST+"/index.html");
    }
    private class ExportBridge {
        @JavascriptInterface public void saveFile(String name,String mime,String base64) {
            if (base64 == null || base64.length()>80*1024*1024) return;
            final byte[] bytes; try {bytes=Base64.decode(base64,Base64.DEFAULT);} catch(IllegalArgumentException e){return;}
            runOnUiThread(()->{
                if(web.getUrl()==null||!web.getUrl().startsWith("https://"+HOST+"/"))return;
                if(pendingExport!=null){Toast.makeText(MainActivity.this,"Finish the current export first",Toast.LENGTH_SHORT).show();return;}
                pendingExport=bytes;pendingName=name.replaceAll("[^A-Za-z0-9._-]","_");pendingMime=mime;
                Intent intent=new Intent(Intent.ACTION_CREATE_DOCUMENT);intent.addCategory(Intent.CATEGORY_OPENABLE);intent.setType(mime);intent.putExtra(Intent.EXTRA_TITLE,pendingName);
                try{startActivityForResult(intent,101);}catch(Exception e){pendingExport=null;Toast.makeText(MainActivity.this,"No document picker available",Toast.LENGTH_LONG).show();}
            });
        }
    }
    @Override protected void onActivityResult(int request,int result,Intent data) {
        super.onActivityResult(request,result,data);
        if(request==100&&fileCallback!=null){fileCallback.onReceiveValue(result==RESULT_OK&&data!=null&&data.getData()!=null?new Uri[]{data.getData()}:null);fileCallback=null;}
        if(request==101&&pendingExport!=null){
            final byte[] bytes=pendingExport;pendingExport=null;
            if(result==RESULT_OK&&data!=null&&data.getData()!=null){final Uri uri=data.getData();new Thread(()->{try(OutputStream out=getContentResolver().openOutputStream(uri)){if(out==null)throw new IOException("No output stream");out.write(bytes);runOnUiThread(()->Toast.makeText(this,"Export saved",Toast.LENGTH_SHORT).show());}catch(IOException e){runOnUiThread(()->Toast.makeText(this,"Export failed",Toast.LENGTH_LONG).show());}}).start();}
        }
    }
    @Override public void onBackPressed(){if(web.canGoBack())web.goBack();else super.onBackPressed();}
    @Override protected void onDestroy(){if(web!=null){web.removeJavascriptInterface("Android");web.destroy();}super.onDestroy();}
}
