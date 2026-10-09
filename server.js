'use strict';
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const unzipper = require('unzipper');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

const app = express();
const PORT = Number(process.env.PORT || 8787);
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
const BUILD_TOKEN = process.env.BUILD_TOKEN || '';
const MAX_UPLOAD_MB = Math.min(Number(process.env.MAX_UPLOAD_MB || 50), 100);
const BUILD_TIMEOUT_MS = Math.min(Number(process.env.BUILD_TIMEOUT_MS || 240000), 600000);
app.disable('x-powered-by');
app.use(cors({ origin: ALLOWED_ORIGIN === '*' ? true : ALLOWED_ORIGIN.split(',').map(s => s.trim()), methods: ['GET','POST','OPTIONS'], allowedHeaders: ['Content-Type','Authorization'] }));
app.use(express.json({ limit: '100kb' }));
app.use(rateLimit({ windowMs: 60_000, limit: 5, standardHeaders: true, legacyHeaders: false }));
const upload = multer({ dest: os.tmpdir(), limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024, files: 1 } });

function auth(req, res, next) {
  if (!BUILD_TOKEN) return next(); // Set BUILD_TOKEN before exposing this service publicly.
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token || !crypto.timingSafeEqual(Buffer.from(token.padEnd(BUILD_TOKEN.length, '\0').slice(0, BUILD_TOKEN.length)), Buffer.from(BUILD_TOKEN))) return res.status(401).json({ error: 'رمز خدمة البناء غير صحيح.' });
  next();
}
function validPackage(p) { return typeof p === 'string' && /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/.test(p) && p.length <= 180; }
function xmlEscape(s) { return String(s).replace(/[<>&"']/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&apos;'}[c])); }
function safeWrite(root, relative, data) { const dest = path.resolve(root, relative); if (!dest.startsWith(path.resolve(root) + path.sep)) throw new Error('مسار ملف غير آمن.'); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, data); }
async function extractSafe(zipPath, outDir) {
  const directory = await unzipper.Open.file(zipPath);
  let total = 0, count = 0, foundIndex = false;
  for (const entry of directory.files) {
    if (entry.type === 'Directory') continue;
    const normalized = entry.path.replace(/\\/g, '/');
    if (!normalized || normalized.startsWith('/') || normalized.split('/').some(p => p === '..') || normalized.includes('\0')) throw new Error('ملف ZIP يحتوي على مسار غير مسموح.');
    if (++count > 2500) throw new Error('عدد الملفات داخل ZIP أكبر من المسموح (2500).');
    total += Number(entry.uncompressedSize || 0);
    if (total > 180 * 1024 * 1024) throw new Error('الحجم بعد فك الضغط يتجاوز 180 ميجابايت.');
    if (normalized.toLowerCase() === 'index.html') foundIndex = true;
    const dest = path.resolve(outDir, normalized);
    if (!dest.startsWith(path.resolve(outDir) + path.sep)) throw new Error('مسار ملف غير آمن.');
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    await new Promise((resolve, reject) => {
      const stream = entry.stream();
      const out = fs.createWriteStream(dest, { flags: 'wx' });
      stream.on('error', reject); out.on('error', reject); out.on('finish', resolve); stream.pipe(out);
    });
  }
  if (!foundIndex) throw new Error('ملف ZIP يجب أن يحتوي على index.html في المجلد الرئيسي.');
}
function makeManifest(c, packageName) {
  const p = c.permissions || {};
  const lines = ['<uses-permission android:name="android.permission.INTERNET" />'];
  if (p.camera) lines.push('<uses-permission android:name="android.permission.CAMERA" />');
  if (p.microphone) lines.push('<uses-permission android:name="android.permission.RECORD_AUDIO" />');
  if (p.location) { lines.push('<uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION" />'); lines.push('<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />'); }
  if (p.vibrate) lines.push('<uses-permission android:name="android.permission.VIBRATE" />');
  if (p.notifications || (c.notifications && c.notifications.enabled)) lines.push('<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />');
  if (c.notifications && c.notifications.enabled && c.notifications.type === 'local') lines.push('<uses-permission android:name="android.permission.RECEIVE_BOOT_COMPLETED" />');
  const orientation = c.orientation === 'portrait' ? 'portrait' : c.orientation === 'landscape' ? 'landscape' : 'unspecified';
  return `<?xml version="1.0" encoding="utf-8"?>\n<manifest xmlns:android="http://schemas.android.com/apk/res/android">\n  ${lines.join('\n  ')}\n  <application android:allowBackup="false" android:label="${xmlEscape(c.appName || 'NEGM App')}" android:theme="@style/AppTheme" android:usesCleartextTraffic="false">\n    <activity android:name=".MainActivity" android:exported="true" android:screenOrientation="${orientation}" android:configChanges="orientation|screenSize|keyboardHidden">\n      <intent-filter><action android:name="android.intent.action.MAIN"/><category android:name="android.intent.category.LAUNCHER"/></intent-filter>\n    </activity>\n  </application>\n</manifest>`;
}
function makeActivity(c) {
 const local = c.sourceMode !== 'url';
 const url = String(c.siteUrl || '').replace(/\\/g,'\\\\').replace(/"/g,'\\"');
 const start = local ? 'file:///android_asset/www/index.html' : url;
 const allowCamera = !!(c.permissions && c.permissions.camera), allowMic = !!(c.permissions && c.permissions.microphone);
 return `package ${c.packageName};

import android.Manifest; import android.app.*; import android.content.*; import android.content.pm.PackageManager; import android.net.Uri; import android.os.Build; import android.os.Bundle; import android.webkit.*; import android.view.*; import android.widget.*; import java.util.*;

public class MainActivity extends Activity {
 private WebView web; private ValueCallback<Uri[]> fileCallback; private String allowedHost = "${local ? "" : (new URL(url).hostname)}"; private static final int FILE_REQUEST=201, PERMISSION_REQUEST=202;
 @Override public void onCreate(Bundle b){super.onCreate(b); getWindow().setStatusBarColor(android.graphics.Color.parseColor("${c.themeColor || '#4f8cff'}")); getWindow().getDecorView().setSystemUiVisibility(0); web=new WebView(this); setContentView(web); WebSettings s=web.getSettings(); s.setJavaScriptEnabled(true); s.setDomStorageEnabled(true); s.setAllowFileAccess(true); s.setAllowContentAccess(true); s.setMediaPlaybackRequiresUserGesture(true); web.setWebChromeClient(new WebChromeClient(){
  @Override public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> cb, FileChooserParams params){ if(fileCallback!=null)fileCallback.onReceiveValue(null); fileCallback=cb; try{startActivityForResult(params.createIntent(),FILE_REQUEST);}catch(Exception e){fileCallback=null;return false;} return true; }
  @Override public void onPermissionRequest(PermissionRequest request){ runOnUiThread(()->{ArrayList<String> androidPerms=new ArrayList<>(); for(String r:request.getResources()){ if(r.equals(PermissionRequest.RESOURCE_VIDEO_CAPTURE)&&${allowCamera})androidPerms.add(Manifest.permission.CAMERA); if(r.equals(PermissionRequest.RESOURCE_AUDIO_CAPTURE)&&${allowMic})androidPerms.add(Manifest.permission.RECORD_AUDIO); } if(androidPerms.isEmpty()){request.deny();return;} boolean granted=true; for(String p:androidPerms)if(checkSelfPermission(p)!=PackageManager.PERMISSION_GRANTED)granted=false; if(granted)request.grant(request.getResources()); else { pendingWebPermission=request; requestPermissions(androidPerms.toArray(new String[0]),PERMISSION_REQUEST); } }); }
 }); web.setWebViewClient(new WebViewClient(){ @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r){ Uri u=r.getUrl(); String host=u.getHost(); if(host==null||host.equals("localhost")||host.equals("appassets.androidplatform.net")||u.toString().startsWith("file:///android_asset/")||(!allowedHost.isEmpty()&&host.equalsIgnoreCase(allowedHost)))return false; if("${c.externalLinks ? 'true':'false'}".equals("true") && ("http".equals(u.getScheme())||"https".equals(u.getScheme()))){ try{startActivity(new Intent(Intent.ACTION_VIEW,u));return true;}catch(Exception e){return false;} } return false; }}); web.loadUrl("${start}"); if(${!!(c.notifications&&c.notifications.enabled&&c.notifications.type==='local')}) scheduleReminder(); }
 private PermissionRequest pendingWebPermission;
 @Override public void onRequestPermissionsResult(int requestCode,String[] permissions,int[] results){super.onRequestPermissionsResult(requestCode,permissions,results);if(requestCode==PERMISSION_REQUEST&&pendingWebPermission!=null){boolean ok=true;for(int r:results)if(r!=PackageManager.PERMISSION_GRANTED)ok=false;if(ok)pendingWebPermission.grant(pendingWebPermission.getResources());else pendingWebPermission.deny();pendingWebPermission=null;}}
 @Override protected void onActivityResult(int req,int result,Intent data){super.onActivityResult(req,result,data);if(req==FILE_REQUEST&&fileCallback!=null){Uri[] resultUris=WebChromeClient.FileChooserParams.parseResult(result,data);fileCallback.onReceiveValue(resultUris);fileCallback=null;}}
 @Override public void onBackPressed(){if(web!=null&&web.canGoBack())web.goBack();else super.onBackPressed();}
 private void scheduleReminder(){try{String title=${JSON.stringify((c.notifications&&c.notifications.title)||'تذكير من التطبيق')};String body=${JSON.stringify((c.notifications&&c.notifications.body)||'لديك تذكير جديد')};String time=${JSON.stringify((c.notifications&&c.notifications.time)||'17:00')};String schedule=${JSON.stringify((c.notifications&&c.notifications.schedule)||'daily')};String[] hm=time.split(":");Calendar cal=Calendar.getInstance();cal.set(Calendar.HOUR_OF_DAY,Integer.parseInt(hm[0]));cal.set(Calendar.MINUTE,Integer.parseInt(hm[1]));cal.set(Calendar.SECOND,0);if(cal.getTimeInMillis()<=System.currentTimeMillis())cal.add(Calendar.DAY_OF_YEAR,1);if("weekly".equals(schedule)){int target=${Number((c.notifications&&c.notifications.weekday)||1)};while(cal.get(Calendar.DAY_OF_WEEK)!=(target==0?Calendar.SUNDAY:target+1))cal.add(Calendar.DAY_OF_YEAR,1);}Intent i=new Intent(this,ReminderReceiver.class);i.putExtra("title",title);i.putExtra("body",body);i.putExtra("schedule",schedule);PendingIntent pi=PendingIntent.getBroadcast(this,991,i,PendingIntent.FLAG_UPDATE_CURRENT|PendingIntent.FLAG_IMMUTABLE);AlarmManager am=(AlarmManager)getSystemService(ALARM_SERVICE);if(am!=null){if(Build.VERSION.SDK_INT>=23)am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP,cal.getTimeInMillis(),pi);else am.set(AlarmManager.RTC_WAKEUP,cal.getTimeInMillis(),pi);}}catch(Exception ignored){}}
}`;
}
function makeReceiver(c) { return `package ${c.packageName}; import android.app.*;import android.content.*;import android.os.Build; public class ReminderReceiver extends BroadcastReceiver { @Override public void onReceive(Context ctx,Intent i){String channel="negm_reminders";if(Build.VERSION.SDK_INT>=26){NotificationChannel ch=new NotificationChannel(channel,"تذكيرات التطبيق",NotificationManager.IMPORTANCE_DEFAULT);((NotificationManager)ctx.getSystemService(Context.NOTIFICATION_SERVICE)).createNotificationChannel(ch);}String title=i.getStringExtra("title"),body=i.getStringExtra("body");Notification.Builder b=Build.VERSION.SDK_INT>=26?new Notification.Builder(ctx,channel):new Notification.Builder(ctx);b.setSmallIcon(android.R.drawable.ic_dialog_info).setContentTitle(title==null?"تذكير":title).setContentText(body==null?"":body).setAutoCancel(true);((NotificationManager)ctx.getSystemService(Context.NOTIFICATION_SERVICE)).notify(991,b.build());String s=i.getStringExtra("schedule");if("daily".equals(s)||"weekly".equals(s)){Intent again=new Intent(ctx,ReminderReceiver.class);again.putExtras(i);PendingIntent pi=PendingIntent.getBroadcast(ctx,991,again,PendingIntent.FLAG_UPDATE_CURRENT|PendingIntent.FLAG_IMMUTABLE);AlarmManager am=(AlarmManager)ctx.getSystemService(Context.ALARM_SERVICE);long delay="weekly".equals(s)?7L*24*60*60*1000:24L*60*60*1000;if(am!=null)am.set(AlarmManager.RTC_WAKEUP,System.currentTimeMillis()+delay,pi);}}}`; }
function makeGradle() { return `plugins { id 'com.android.application' version '8.7.3' }\n\nandroid { namespace 'com.negm.generated' ; compileSdk 35\n defaultConfig { applicationId 'com.negm.generated'; minSdk 23; targetSdk 35; versionCode 1; versionName '1.0' }\n}`; }
function run(cmd,args,opts={}) { return new Promise((resolve,reject)=>{const p=spawn(cmd,args,{...opts,stdio:['ignore','pipe','pipe']});let out='',err='';p.stdout.on('data',d=>out+=d.toString());p.stderr.on('data',d=>err+=d.toString());const timer=setTimeout(()=>{p.kill('SIGKILL');reject(new Error('انتهت مهلة البناء.'))},BUILD_TIMEOUT_MS);p.on('error',e=>{clearTimeout(timer);reject(e)});p.on('close',code=>{clearTimeout(timer);if(code===0)resolve(out+'\n'+err);else reject(new Error((err||out||'Gradle build failed').slice(-5000)));});}); }
app.get('/health',(_,res)=>res.json({ok:true,service:'NEGM APP BUILDER build worker',requiresAndroidSdk:true}));
app.post('/build',auth,upload.single('project'),async(req,res)=>{
 const work=fs.mkdtempSync(path.join(os.tmpdir(),'negm-build-'));try{
  let c;try{c=JSON.parse(req.body.config||'{}')}catch{throw new Error('إعدادات المشروع غير صالحة.');}
  if(!c.appName||!validPackage(c.packageName))throw new Error('اسم التطبيق أو اسم الحزمة غير صالح.');
  const appRoot=path.join(work,'app'); const javaPath=path.join(appRoot,'src/main/java',...c.packageName.split('.')); const resValues=path.join(appRoot,'src/main/res/values'); const assets=path.join(appRoot,'src/main/assets/www'); fs.mkdirSync(javaPath,{recursive:true});fs.mkdirSync(resValues,{recursive:true});fs.mkdirSync(assets,{recursive:true});
  if(c.sourceMode==='local') { if(!req.file)throw new Error('ارفع ملف ZIP للمشروع.'); await extractSafe(req.file.path,assets); }
  else { if(!/^https:\/\//i.test(c.siteUrl||''))throw new Error('رابط الموقع يجب أن يكون HTTPS.'); safeWrite(assets,'index.html',`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="font-family:sans-serif;padding:24px"><p>يتم فتح الموقع الخارجي في التطبيق.</p></body></html>`); }
  if(req.body.iconDataUrl){const m=String(req.body.iconDataUrl).match(/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/);if(m){const ext=m[1]==='jpeg'?'jpg':m[1];safeWrite(appRoot,'src/main/res/drawable/app_icon.'+ext,Buffer.from(m[2],'base64'));}}
  safeWrite(work,'settings.gradle',`pluginManagement { repositories { google(); mavenCentral(); gradlePluginPortal() } }\ndependencyResolutionManagement { repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS); repositories { google(); mavenCentral() } }\nrootProject.name = 'NEGMGeneratedApp'\ninclude ':app'\n`);
  safeWrite(work,'build.gradle',`plugins { id 'com.android.application' version '8.7.3' apply false }\n`);
  safeWrite(appRoot,'build.gradle',`plugins { id 'com.android.application' }\nandroid { namespace '${c.packageName}'; compileSdk 35\n defaultConfig { applicationId '${c.packageName}'; minSdk 23; targetSdk 35; versionCode 1; versionName '${String(c.versionName||'1.0').replace(/[^0-9A-Za-z._+-]/g,'')}' }\n}`);
  safeWrite(appRoot,'src/main/AndroidManifest.xml',makeManifest(c,c.packageName));
  safeWrite(resValues,'styles.xml',`<resources><style name="AppTheme" parent="android:style/Theme.Material.Light.NoActionBar"><item name="android:fontFamily">sans</item><item name="android:colorAccent">${c.themeColor||'#4f8cff'}</item><item name="android:windowLightStatusBar">${c.statusBar==='light'?'true':'false'}</item><item name="android:windowActionModeOverlay">true</item></style></resources>`);
  safeWrite(javaPath,'MainActivity.java',makeActivity(c));
  if(c.notifications&&c.notifications.enabled&&c.notifications.type==='local'){safeWrite(javaPath,'ReminderReceiver.java',makeReceiver(c));let manifest=fs.readFileSync(path.join(appRoot,'src/main/AndroidManifest.xml'),'utf8').replace('</application>',`<receiver android:name=".ReminderReceiver" android:enabled="true" android:exported="false" /></application>`);fs.writeFileSync(path.join(appRoot,'src/main/AndroidManifest.xml'),manifest);}
  // Ensure Java namespace and Gradle namespace match package.
  const output=path.join(work,'app/build/outputs/apk/debug/app-debug.apk');
  await run(process.env.GRADLE_CMD||'gradle',['--no-daemon','--stacktrace','assembleDebug'],{cwd:work,env:{...process.env,GRADLE_OPTS:'-Xmx2g -Dfile.encoding=UTF-8'}});
  if(!fs.existsSync(output))throw new Error('انتهى Gradle دون إنشاء ملف APK متوقع.');
  res.setHeader('Content-Type','application/vnd.android.package-archive');res.setHeader('Content-Disposition',`attachment; filename="${c.packageName.split('.').pop()||'app'}-debug.apk"`);res.sendFile(output,err=>{if(err&&!res.headersSent)res.status(500).json({error:'تعذر إرسال APK.'});});
 }catch(e){res.status(400).json({error:e.message||'حدث خطأ أثناء البناء.'});}finally{setTimeout(()=>{try{fs.rmSync(work,{recursive:true,force:true});if(req.file)fs.rmSync(req.file.path,{force:true});}catch{}},60_000);}
});
app.listen(PORT,'0.0.0.0',()=>console.log(`NEGM build worker listening on ${PORT}`));
