module.exports=url=>String(url||'').replace(/([?&](?:image_access|token|access_token|authorization)=)[^&]*/gi,'$1[redacted]');
