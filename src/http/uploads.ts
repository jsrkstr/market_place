import express, { type ErrorRequestHandler, type Express, type Request, type Response } from 'express';
import { DomainError } from '../domain/errors.js';
import { addPhotoFromUpload, MAX_IMAGE_BYTES, resolveUploadToken } from '../domain/photos.service.js';

export const escapeHtml = (s: string) =>
  s.replace(/[&<>"'`]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' })[c]!);

const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' blob:; form-action 'none'; frame-ancestors 'none'; base-uri 'none'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-store',
};

function page(body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Add photos</title>
<style>
  body{font-family:system-ui,-apple-system,sans-serif;margin:0;padding:24px 16px;background:#f6f6f4;color:#222}
  main{max-width:480px;margin:0 auto;background:#fff;border-radius:14px;padding:20px;box-shadow:0 1px 4px rgba(0,0,0,.08)}
  h1{font-size:1.25rem;margin:0 0 8px} p{line-height:1.45}
  label.pick{display:block;text-align:center;padding:18px;border:2px dashed #999;border-radius:12px;cursor:pointer;font-weight:600}
  input[type=file]{position:absolute;left:-9999px}
  ul{list-style:none;padding:0} li{display:flex;align-items:center;gap:10px;margin:8px 0;font-size:.95rem}
  li img{width:56px;height:56px;object-fit:cover;border-radius:8px;background:#eee}
  .ok{color:#1a7f37}.err{color:#b42318}.muted{color:#666;font-size:.9rem}
</style></head>
<body><main>${body}</main></body></html>`;
}

const UPLOAD_SCRIPT = `
(function(){
  var input=document.getElementById('files'),list=document.getElementById('list'),done=document.getElementById('done');
  var MAX=${MAX_IMAGE_BYTES};
  input.addEventListener('change',function(){
    var files=Array.prototype.slice.call(input.files||[]);input.value='';
    files.reduce(function(p,f){return p.then(function(){return send(f);});},Promise.resolve());
  });
  function send(f){
    var li=document.createElement('li'),img=document.createElement('img'),s=document.createElement('span');
    try{img.src=URL.createObjectURL(f);}catch(e){}
    s.textContent=f.name+': uploading…';li.appendChild(img);li.appendChild(s);list.appendChild(li);
    if(f.size>MAX){s.textContent=f.name+': too large (max 10 MB)';s.className='err';return Promise.resolve();}
    return fetch(location.pathname,{method:'POST',headers:{'Content-Type':f.type||'application/octet-stream'},body:f})
      .then(function(r){return r.json().catch(function(){return {};}).then(function(j){
        if(r.ok){s.textContent=f.name+': added';s.className='ok';done.hidden=false;}
        else{s.textContent=f.name+': '+(j.error||'failed');s.className='err';}
      });})
      .catch(function(){s.textContent=f.name+': network error';s.className='err';});
  }
})();`;

function uploadPage(title: string | null): string {
  const name = escapeHtml(title?.trim() || 'your listing');
  return page(`<h1>Add photos to ${name}</h1>
<p class="muted">Photos help buyers decide. Choose one or several (JPEG, PNG, WebP or HEIC, up to 10 MB each).</p>
<label class="pick" for="files">Choose photos</label>
<input id="files" type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif" multiple>
<ul id="list"></ul>
<p id="done" hidden>Done? Go back to ChatGPT and say “I've added the photos”.</p>
<script>${UPLOAD_SCRIPT}</script>`);
}

const expiredPage = () =>
  page(`<h1>This upload link has expired</h1><p>Ask the Marketplace app in ChatGPT for a new photo upload link.</p>`);

/** GET/POST /upload/:token: browser photo upload fallback (no multipart; each file is a raw POST body). */
export function mountUploadRoutes(app: Express): void {
  const router = express.Router();
  const rawImage = express.raw({ type: ['image/*', 'application/octet-stream'], limit: '10mb' });

  router.get('/:token', async (req: Request, res: Response) => {
    res.set(SECURITY_HEADERS);
    const t = await resolveUploadToken(String(req.params.token));
    if (!t) {
      res.status(404).type('html').send(expiredPage());
      return;
    }
    res.type('html').send(uploadPage(t.listingTitle));
  });

  router.post('/:token', rawImage, async (req: Request, res: Response) => {
    res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      res.status(415).json({ error: 'Send the image as the raw request body with an image Content-Type' });
      return;
    }
    try {
      const img = await addPhotoFromUpload(String(req.params.token), req.body, req.get('content-type') ?? null);
      res.status(201).json({ ok: true, imageId: img.id });
    } catch (err) {
      if (err instanceof DomainError) {
        res.status(err.code === 'not_found' ? 404 : err.code === 'forbidden' ? 403 : 400).json({ error: err.message });
        return;
      }
      console.error('[upload] failed', err);
      res.status(500).json({ error: 'Upload failed' });
    }
  });

  const onError: ErrorRequestHandler = (err, _req, res, next) => {
    if (res.headersSent) return next(err);
    const status = typeof err?.status === 'number' ? err.status : 500;
    res.status(status).json({ error: status === 413 ? 'Image is larger than 10 MB' : 'Upload failed' });
  };
  router.use(onError);

  app.use('/upload', router);
}
