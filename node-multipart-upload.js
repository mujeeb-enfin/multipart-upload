/**
 * Node.js Express Multipart Upload Handler
 * Compatible with the JavaScript multipart upload function
 */

const express = require('express');
const multer = require('multer');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const axios = require('axios');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// Configuration
const CONFIG = {
  uploadDir: path.join(__dirname, 'uploads'),
  tempDir: path.join(__dirname, 'temp', 'multipart_uploads'),
  maxFileSize: 5 * 1024 * 1024 * 1024, // 5GB
  allowedExtensions: ['.mp4', '.mov', '.avi', '.mkv', '.webm', '.flv', '.jpg', '.png', '.pdf'],
  sessionMaxAge: 24 * 60 * 60 * 1000 // 24 hours
};

// In-memory session store (use Redis in production)
const uploadSessions = new Map();

// Ensure directories exist
async function ensureDirectories() {
  await fs.mkdir(CONFIG.uploadDir, { recursive: true });
  await fs.mkdir(CONFIG.tempDir, { recursive: true });
}

ensureDirectories();

// Configure multer for file uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 100 * 1024 * 1024 // 100MB per chunk
  }
});

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// CORS (adjust as needed)
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

/**
 * Main upload endpoint
 */
app.post('/upload', upload.single('file'), async (req, res) => {
  try {
    // Check for abort request
    if (req.body.abort_upload === 'true') {
      return await handleAbortUpload(req, res);
    }

    // Check if multipart upload
    if (req.body.is_multipart === 'true') {
      return await handleMultipartUpload(req, res);
    }

    // Regular single file upload
    return await handleSingleUpload(req, res);

  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Handle multipart chunk upload
 */
async function handleMultipartUpload(req, res) {
  const {
    upload_id,
    chunk_number,
    total_chunks,
    is_last_chunk,
    original_filename,
    object_name,
    path_payload
  } = req.body;

  // Validate required parameters
  if (!upload_id || !chunk_number || !total_chunks || !is_last_chunk || !original_filename) {
    return res.status(400).json({
      success: false,
      error: 'Missing required parameters'
    });
  }

  const chunkNum = parseInt(chunk_number);
  const totalChunks = parseInt(total_chunks);
  const isLast = is_last_chunk === 'true';

  if (!req.file) {
    return res.status(400).json({
      success: false,
      error: 'No file uploaded'
    });
  }

  console.log(`Multipart upload: ${upload_id}, chunk ${chunkNum}/${totalChunks}`);

  // Validate filename
  const ext = path.extname(original_filename).toLowerCase();
  if (!CONFIG.allowedExtensions.includes(ext)) {
    return res.status(400).json({
      success: false,
      error: `File type ${ext} not allowed`
    });
  }

  // Initialize session on first chunk
  if (chunkNum === 1) {
    const sessionDir = path.join(CONFIG.tempDir, upload_id);
    await fs.mkdir(sessionDir, { recursive: true });

    uploadSessions.set(upload_id, {
      sessionDir,
      chunks: new Map(),
      totalChunks,
      original_filename,
      object_name,
      path_payload,
      startedAt: Date.now()
    });

    console.log(`Initialized upload session: ${upload_id}`);
  }

  // Get session
  const session = uploadSessions.get(upload_id);
  if (!session) {
    return res.status(400).json({
      success: false,
      error: 'Upload session not found. Please start from chunk 1.'
    });
  }

  // Save chunk
  const chunkPath = path.join(session.sessionDir, `chunk_${chunkNum}`);
  await fs.writeFile(chunkPath, req.file.buffer);
  session.chunks.set(chunkNum, chunkPath);

  console.log(`Saved chunk ${chunkNum}, size: ${req.file.buffer.length} bytes`);

  // If not last chunk, return progress
  if (!isLast) {
    return res.json({
      success: true,
      message: `Chunk ${chunkNum}/${totalChunks} uploaded successfully`,
      upload_id,
      chunk_number: chunkNum,
      total_chunks: totalChunks,
      chunks_received: session.chunks.size
    });
  }

  // Last chunk - assemble and finalize
  return await assembleAndFinalize(upload_id, session, res);
}

/**
 * Assemble chunks and finalize upload
 */
async function assembleAndFinalize(uploadId, session, res) {
  try {
    const { sessionDir, chunks, totalChunks, original_filename, object_name, path_payload } = session;

    // Verify all chunks are present
    const missingChunks = [];
    for (let i = 1; i <= totalChunks; i++) {
      if (!chunks.has(i)) {
        missingChunks.push(i);
      }
    }

    if (missingChunks.length > 0) {
      throw new Error(`Missing chunks: ${missingChunks.join(', ')}`);
    }

    // Assemble chunks
    const assembledPath = path.join(sessionDir, 'assembled_file');
    const writeStream = fsSync.createWriteStream(assembledPath);

    for (let i = 1; i <= totalChunks; i++) {
      const chunkPath = chunks.get(i);
      const chunkData = await fs.readFile(chunkPath);
      writeStream.write(chunkData);
    }

    writeStream.end();

    // Wait for write to complete
    await new Promise((resolve, reject) => {
      writeStream.on('finish', resolve);
      writeStream.on('error', reject);
    });

    console.log(`Assembled file at ${assembledPath}`);

    // Determine final filename
    let finalFilename = original_filename;
    if (object_name) {
      finalFilename = path.basename(object_name);
    } else if (path_payload) {
      finalFilename = await resolvePathWithPayload(path_payload, original_filename);
    }

    // Move to final destination
    const finalPath = path.join(CONFIG.uploadDir, finalFilename);
    const finalDir = path.dirname(finalPath);
    await fs.mkdir(finalDir, { recursive: true });
    await fs.rename(assembledPath, finalPath);

    console.log(`Moved assembled file to ${finalPath}`);

    // Get file stats
    const stats = await fs.stat(finalPath);

    // Cleanup
    await cleanupSession(uploadId, sessionDir);

    // Generate response
    const fileUrl = generateFileUrl(finalFilename);

    return res.json({
      success: true,
      message: `File '${original_filename}' uploaded successfully via multipart upload.`,
      s3_url: fileUrl,
      file_url: fileUrl,
      object_name: finalFilename,
      source: 'multipart_upload',
      original_filename,
      upload_id: uploadId,
      total_chunks: totalChunks,
      file_size: stats.size
    });

  } catch (error) {
    await cleanupSession(uploadId, session.sessionDir);
    throw error;
  }
}

/**
 * Handle regular single file upload
 */
async function handleSingleUpload(req, res) {
  try {
    // Handle public URL download
    if (req.body.public_url) {
      return await handleUrlDownload(req, res);
    }

    // Handle file upload
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: 'No file uploaded'
      });
    }

    const originalFilename = req.file.originalname;
    const ext = path.extname(originalFilename).toLowerCase();

    // Validate extension
    if (!CONFIG.allowedExtensions.includes(ext)) {
      return res.status(400).json({
        success: false,
        error: `File type ${ext} not allowed`
      });
    }

    // Validate file size
    if (req.file.size > CONFIG.maxFileSize) {
      return res.status(400).json({
        success: false,
        error: 'File size exceeds maximum allowed size'
      });
    }

    // Determine final filename
    let finalFilename = originalFilename;
    if (req.body.object_name) {
      finalFilename = path.basename(req.body.object_name);
    } else if (req.body.path_payload) {
      finalFilename = await resolvePathWithPayload(req.body.path_payload, originalFilename);
    }

    // Save file
    const finalPath = path.join(CONFIG.uploadDir, finalFilename);
    const finalDir = path.dirname(finalPath);
    await fs.mkdir(finalDir, { recursive: true });
    await fs.writeFile(finalPath, req.file.buffer);

    const stats = await fs.stat(finalPath);
    const fileUrl = generateFileUrl(finalFilename);

    return res.json({
      success: true,
      message: `File '${originalFilename}' uploaded successfully.`,
      s3_url: fileUrl,
      file_url: fileUrl,
      object_name: finalFilename,
      source: 'file_upload',
      original_filename: originalFilename,
      file_size: stats.size
    });

  } catch (error) {
    throw error;
  }
}

/**
 * Handle download from public URL
 */
async function handleUrlDownload(req, res) {
  const publicUrl = req.body.public_url;

  if (!publicUrl) {
    return res.status(400).json({
      success: false,
      error: 'public_url is required'
    });
  }

  try {
    console.log(`Downloading from URL: ${publicUrl}`);

    // Download file
    const response = await axios({
      method: 'get',
      url: publicUrl,
      responseType: 'arraybuffer',
      timeout: 60000,
      maxContentLength: CONFIG.maxFileSize
    });

    // Extract filename from URL
    const urlPath = new URL(publicUrl).pathname;
    const originalFilename = path.basename(urlPath) || `downloaded_${Date.now()}`;

    // Determine final filename
    let finalFilename = originalFilename;
    if (req.body.object_name) {
      finalFilename = path.basename(req.body.object_name);
    } else if (req.body.path_payload) {
      finalFilename = await resolvePathWithPayload(req.body.path_payload, originalFilename);
    }

    // Save file
    const finalPath = path.join(CONFIG.uploadDir, finalFilename);
    const finalDir = path.dirname(finalPath);
    await fs.mkdir(finalDir, { recursive: true });
    await fs.writeFile(finalPath, response.data);

    const stats = await fs.stat(finalPath);
    const fileUrl = generateFileUrl(finalFilename);

    return res.json({
      success: true,
      message: 'File downloaded and uploaded successfully.',
      s3_url: fileUrl,
      file_url: fileUrl,
      object_name: finalFilename,
      source: 'public_url',
      original_filename: originalFilename,
      file_size: stats.size
    });

  } catch (error) {
    console.error('URL download error:', error);
    return res.status(400).json({
      success: false,
      error: `Failed to download from URL: ${error.message}`
    });
  }
}

/**
 * Handle abort upload
 */
async function handleAbortUpload(req, res) {
  const uploadId = req.body.upload_id;

  if (!uploadId) {
    return res.status(400).json({
      success: false,
      error: 'upload_id is required'
    });
  }

  const session = uploadSessions.get(uploadId);
  if (session) {
    await cleanupSession(uploadId, session.sessionDir);
  }

  return res.json({
    success: true,
    message: 'Upload aborted',
    upload_id: uploadId
  });
}

/**
 * Resolve path with payload
 */
async function resolvePathWithPayload(pathPayload, filename) {
  try {
    const payload = typeof pathPayload === 'string' ? JSON.parse(pathPayload) : pathPayload;

    if (!payload.path_key) {
      return filename;
    }

    // Example: create path structure based on payload
    let basePath = payload.path_key + '/';

    if (payload.user_id) {
      basePath += payload.user_id + '/';
    }

    if (payload.date) {
      basePath += payload.date + '/';
    }

    return basePath + filename;

    // In production, you might call an external path service:
    // const response = await axios.post('http://path-service/generate', payload);
    // return response.data.path + '/' + filename;

  } catch (error) {
    console.error('Path resolution error:', error);
    return filename;
  }
}

/**
 * Generate file URL
 */
function generateFileUrl(filename) {
  const protocol = process.env.USE_HTTPS === 'true' ? 'https' : 'http';
  const host = process.env.HOST || 'localhost';
  const port = process.env.PORT || PORT;
  const baseUrl = port === 80 || port === 443 ? `${protocol}://${host}` : `${protocol}://${host}:${port}`;

  return `${baseUrl}/files/${filename}`;
}

/**
 * Cleanup session
 */
async function cleanupSession(uploadId, sessionDir) {
  try {
    if (fsSync.existsSync(sessionDir)) {
      await fs.rm(sessionDir, { recursive: true, force: true });
      console.log(`Cleaned up session directory: ${sessionDir}`);
    }

    uploadSessions.delete(uploadId);
    console.log(`Removed upload session: ${uploadId}`);

  } catch (error) {
    console.error(`Failed to cleanup session ${uploadId}:`, error);
  }
}

/**
 * Clean old sessions (run periodically)
 */
async function cleanOldSessions() {
  const now = Date.now();

  for (const [uploadId, session] of uploadSessions.entries()) {
    if (now - session.startedAt > CONFIG.sessionMaxAge) {
      console.log(`Cleaning old session: ${uploadId}`);
      await cleanupSession(uploadId, session.sessionDir);
    }
  }
}

// Run cleanup every 6 hours
setInterval(cleanOldSessions, 6 * 60 * 60 * 1000);

/**
 * Serve uploaded files
 */
app.use('/files', express.static(CONFIG.uploadDir));

/**
 * Health check endpoint
 */
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    activeSessions: uploadSessions.size,
    uptime: process.uptime()
  });
});

/**
 * Start server
 */
app.listen(PORT, () => {
  console.log(`Upload server running on port ${PORT}`);
  console.log(`Upload endpoint: http://localhost:${PORT}/upload`);
  console.log(`Files directory: ${CONFIG.uploadDir}`);
  console.log(`Temp directory: ${CONFIG.tempDir}`);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, cleaning up...');
  await cleanOldSessions();
  process.exit(0);
});

module.exports = app;
