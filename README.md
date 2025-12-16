# Multipart Video Upload System

A comprehensive multipart file upload system supporting large video files with chunked uploads. Includes client-side JavaScript and server implementations in Python (FastAPI), PHP, and Node.js.

## 📋 Features

- ✅ **Chunked Uploads** - Split large files into manageable chunks (default 5MB)
- ✅ **Progress Tracking** - Real-time upload progress callbacks
- ✅ **Automatic Retries** - Failed chunks retry automatically (3 attempts)
- ✅ **Resume Support** - Handle network interruptions gracefully
- ✅ **Multiple Backends** - Python, PHP, or Node.js server options
- ✅ **File Validation** - Extension and size validation
- ✅ **Path Generation** - Dynamic path resolution with payload
- ✅ **URL Downloads** - Upload from public URLs
- ✅ **Session Management** - Track upload progress across chunks
- ✅ **Auto Cleanup** - Remove incomplete/old uploads

## 📁 Project Structure

```
multipart-upload/
├── client/
│   ├── upload.html          # Demo HTML page with upload UI
│   └── upload.js            # JavaScript upload functions
├── server/
│   ├── python/
│   │   └── upload_handler.py    # FastAPI implementation
│   ├── php/
│   │   └── upload.php           # PHP implementation
│   └── nodejs/
│       ├── server.js            # Express implementation
│       └── package.json
└── README.md
```

## 🚀 Quick Start

### Client-Side (JavaScript)

```javascript
import { uploadVideo } from './upload.js';

const fileInput = document.getElementById('file-input');
const videoFile = fileInput.files[0];

uploadVideo(videoFile, {
  uploadUrl: 'http://localhost:3000/upload',
  multipartThreshold: 10 * 1024 * 1024, // Use multipart for files > 10MB
  chunkSize: 5 * 1024 * 1024,           // 5MB chunks
  onProgress: (percent) => {
    console.log(`Upload: ${percent}%`);
    document.getElementById('progress').value = percent;
  },
  onChunkComplete: (current, total) => {
    console.log(`Chunk ${current}/${total} completed`);
  }
})
.then(result => {
  console.log('Upload successful:', result);
  alert('File uploaded: ' + result.file_url);
})
.catch(error => {
  console.error('Upload failed:', error);
  alert('Upload failed: ' + error.message);
});
```

### Server Setup

Choose your preferred backend:

#### Option 1: Python (FastAPI)

```bash
# Install dependencies
pip install fastapi uvicorn python-multipart httpx requests

# Run server
uvicorn upload_handler:app --host 0.0.0.0 --port 8000
```

#### Option 2: PHP

```bash
# Configure paths in upload.php
php -S localhost:8000 upload.php

# Or use Apache/Nginx with PHP-FPM
```

#### Option 3: Node.js (Express)

```bash
# Install dependencies
npm install express multer axios

# Run server
node server.js

# Or with nodemon for development
npm install -g nodemon
nodemon server.js
```

## 📖 API Documentation

### Upload Endpoint

**URL:** `POST /upload`

**Content-Type:** `multipart/form-data`

### Regular Upload Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `file` | File | Yes* | File to upload |
| `public_url` | String | Yes* | URL to download file from |
| `object_name` | String | No | Custom object name in storage |
| `path_payload` | JSON String | No | Path generation payload |

*Either `file` or `public_url` must be provided

### Multipart Upload Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `file` | File | Yes | Chunk data |
| `is_multipart` | String | Yes | Set to "true" |
| `upload_id` | String | Yes | Unique upload session ID |
| `chunk_number` | String | Yes | Current chunk number (1-based) |
| `total_chunks` | String | Yes | Total number of chunks |
| `is_last_chunk` | String | Yes | "true" for last chunk |
| `original_filename` | String | Yes | Original file name |
| `object_name` | String | No | Custom object name |
| `path_payload` | JSON String | No | Path generation payload |

### Abort Upload

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `abort_upload` | String | Yes | Set to "true" |
| `upload_id` | String | Yes | Upload session ID to abort |

### Response Format

```json
{
  "success": true,
  "message": "File 'video.mp4' uploaded successfully.",
  "s3_url": "http://localhost:3000/files/video.mp4",
  "file_url": "http://localhost:3000/files/video.mp4",
  "object_name": "video.mp4",
  "source": "multipart_upload",
  "original_filename": "video.mp4",
  "upload_id": "1234567890-abc123",
  "total_chunks": 20,
  "file_size": 104857600
}
```

## 🔧 Configuration

### Client Configuration

```javascript
const config = {
  uploadUrl: 'http://localhost:3000/upload',
  multipartThreshold: 10 * 1024 * 1024,  // 10MB
  chunkSize: 5 * 1024 * 1024,            // 5MB
  headers: {
    'Authorization': 'Bearer YOUR_TOKEN'
  },
  objectName: 'videos/my-video.mp4',
  pathPayload: {
    path_key: 'user_uploads',
    user_id: '12345',
    date: '2024-01-15'
  }
};
```

### Server Configuration

#### Python (FastAPI)
```python
# In upload_handler.py
settings = Settings(
    provider='s3',  # or 'local', 'gcs', etc.
    bucket_name='my-bucket',
    upload_dir='/var/www/uploads',
    max_file_size=5 * 1024 * 1024 * 1024  # 5GB
)
```

#### PHP
```php
// In upload.php
$config = [
    'upload_dir' => __DIR__ . '/uploads/',
    'temp_dir' => sys_get_temp_dir() . '/multipart_uploads/',
    'max_file_size' => 5 * 1024 * 1024 * 1024,  // 5GB
    'allowed_extensions' => ['mp4', 'mov', 'avi', 'mkv', 'webm']
];
```

#### Node.js
```javascript
// In server.js
const CONFIG = {
  uploadDir: path.join(__dirname, 'uploads'),
  tempDir: path.join(__dirname, 'temp', 'multipart_uploads'),
  maxFileSize: 5 * 1024 * 1024 * 1024,  // 5GB
  allowedExtensions: ['.mp4', '.mov', '.avi', '.mkv', '.webm'],
  sessionMaxAge: 24 * 60 * 60 * 1000  // 24 hours
};
```

## 💡 Usage Examples

### Basic Upload

```javascript
// Automatic mode (chooses single or multipart based on size)
uploadVideo(file, {
  uploadUrl: '/upload',
  onProgress: (p) => console.log(`${p}%`)
});
```

### Force Multipart Upload

```javascript
// Force multipart for all files
uploadVideoMultipart(file, {
  uploadUrl: '/upload',
  chunkSize: 10 * 1024 * 1024,  // 10MB chunks
  onProgress: (percent) => {
    progressBar.value = percent;
  },
  onChunkComplete: (current, total) => {
    statusText.textContent = `Uploading chunk ${current} of ${total}`;
  }
});
```

### Upload from URL

```javascript
uploadVideoSingle(null, {
  uploadUrl: '/upload',
  publicUrl: 'https://example.com/video.mp4',
  objectName: 'downloads/video.mp4'
});
```

### With Custom Path

```javascript
uploadVideo(file, {
  uploadUrl: '/upload',
  pathPayload: {
    path_key: 'user_uploads',
    user_id: '12345',
    category: 'videos',
    date: '2024-01-15'
  }
});
```

### With Authentication

```javascript
uploadVideo(file, {
  uploadUrl: '/upload',
  headers: {
    'Authorization': 'Bearer YOUR_JWT_TOKEN',
    'X-Custom-Header': 'value'
  }
});
```

## 🔒 Security Considerations

1. **File Validation**
   - Validate file extensions on both client and server
   - Check MIME types
   - Limit file sizes

2. **Authentication**
   - Implement proper authentication/authorization
   - Use secure tokens
   - Validate upload sessions

3. **Path Traversal**
   - Sanitize all file names
   - Prevent directory traversal attacks
   - Use basename() for filenames

4. **Rate Limiting**
   - Implement rate limiting per IP/user
   - Limit concurrent uploads
   - Set request timeouts

5. **Storage**
   - Use secure storage locations
   - Implement access controls
   - Scan uploaded files for malware

## 🐛 Troubleshooting

### Upload Fails After First Chunk

**Problem:** Session not found error after first chunk.

**Solution:** Ensure server is storing session data properly. Check temp directory permissions.

```bash
# Check temp directory
ls -la /tmp/multipart_uploads/

# Fix permissions
chmod 755 /tmp/multipart_uploads/
```

### Memory Issues with Large Files

**Problem:** Server runs out of memory.

**Solution:** 
- Reduce chunk size on client
- Use streaming on server (already implemented)
- Increase server memory limits

```javascript
// Reduce chunk size
uploadVideo(file, {
  chunkSize: 2 * 1024 * 1024  // 2MB instead of 5MB
});
```

### CORS Errors

**Problem:** Cross-origin request blocked.

**Solution:** Configure CORS headers on server.

```javascript
// Node.js
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  next();
});
```

### Chunks Arriving Out of Order

**Problem:** Chunks processed in wrong order.

**Solution:** Server already handles this by using chunk numbers. Ensure chunks are sent sequentially from client.

## 🔄 Cleanup and Maintenance

### Python
```python
# Manual cleanup
cleanup_old_sessions(max_age=86400)  # 24 hours
```

### PHP
```bash
# Add to crontab
0 */6 * * * php /path/to/upload.php cleanup
```

### Node.js
```javascript
// Runs automatically every 6 hours
// Or manually trigger:
cleanOldSessions();
```

## 📊 Performance Tips

1. **Optimize Chunk Size**
   - Smaller chunks: Better for unstable networks
   - Larger chunks: Faster for stable networks
   - Recommended: 5-10MB

2. **Parallel Uploads**
   - Current implementation: Sequential
   - For faster uploads: Implement parallel chunk uploads
   - Trade-off: More server resources

3. **Production Deployment**
   - Use Redis for session storage
   - Implement CDN for file delivery
   - Use object storage (S3, GCS, etc.)
   - Enable HTTP/2 or HTTP/3

## 📝 License

MIT License - Feel free to use in your projects!

## 🤝 Contributing

Contributions welcome! Please:
1. Fork the repository
2. Create a feature branch
3. Commit your changes
4. Push to the branch
5. Open a Pull Request

## 📧 Support

For issues and questions:
- Open an issue on GitHub
- Check existing issues for solutions
- Provide detailed error logs

## 🔗 Related Projects

- [tus.io](https://tus.io/) - Resumable upload protocol
- [Uppy](https://uppy.io/) - File uploader for web browsers
- [Resumable.js](http://www.resumablejs.com/) - JavaScript library for chunked uploads

---

**Version:** 1.0.0  
**Last Updated:** December 2024
