<?php
/**
 * PHP Multipart Upload Handler
 * Compatible with the JavaScript multipart upload function
 */

class MultipartUploadHandler {
    
    private $uploadDir;
    private $tempDir;
    private $maxFileSize;
    private $allowedExtensions;
    
    public function __construct($config = []) {
        $this->uploadDir = $config['upload_dir'] ?? 'uploads/';
        $this->tempDir = $config['temp_dir'] ?? sys_get_temp_dir() . '/multipart_uploads/';
        $this->maxFileSize = $config['max_file_size'] ?? 5 * 1024 * 1024 * 1024; // 5GB
        $this->allowedExtensions = $config['allowed_extensions'] ?? ['mp4', 'mov', 'avi', 'mkv', 'webm', 'flv'];
        
        // Create directories if they don't exist
        if (!file_exists($this->uploadDir)) {
            mkdir($this->uploadDir, 0755, true);
        }
        if (!file_exists($this->tempDir)) {
            mkdir($this->tempDir, 0755, true);
        }
    }
    
    /**
     * Main upload handler
     */
    public function handleUpload() {
        try {
            // Check if it's an abort request
            if (isset($_POST['abort_upload']) && $_POST['abort_upload'] === 'true') {
                return $this->abortUpload();
            }
            
            // Check if it's a multipart upload
            if (isset($_POST['is_multipart']) && $_POST['is_multipart'] === 'true') {
                return $this->handleMultipartUpload();
            }
            
            // Regular single file upload
            return $this->handleSingleUpload();
            
        } catch (Exception $e) {
            http_response_code(500);
            return [
                'success' => false,
                'error' => $e->getMessage()
            ];
        }
    }
    
    /**
     * Handle multipart chunk upload
     */
    private function handleMultipartUpload() {
        // Validate required parameters
        $required = ['upload_id', 'chunk_number', 'total_chunks', 'is_last_chunk', 'original_filename'];
        foreach ($required as $param) {
            if (!isset($_POST[$param])) {
                throw new Exception("Missing required parameter: $param");
            }
        }
        
        $uploadId = $this->sanitize($_POST['upload_id']);
        $chunkNumber = (int)$_POST['chunk_number'];
        $totalChunks = (int)$_POST['total_chunks'];
        $isLastChunk = $_POST['is_last_chunk'] === 'true';
        $originalFilename = basename($_POST['original_filename']);
        $objectName = isset($_POST['object_name']) ? $_POST['object_name'] : null;
        $pathPayload = isset($_POST['path_payload']) ? $_POST['path_payload'] : null;
        
        // Validate file upload
        if (!isset($_FILES['file']) || $_FILES['file']['error'] !== UPLOAD_ERR_OK) {
            throw new Exception("File upload error");
        }
        
        // Validate filename
        if (!$this->isValidFilename($originalFilename)) {
            throw new Exception("Invalid filename");
        }
        
        // Create upload session directory
        $sessionDir = $this->tempDir . $uploadId . '/';
        if ($chunkNumber === 1 && !file_exists($sessionDir)) {
            mkdir($sessionDir, 0755, true);
            
            // Store session metadata
            $metadata = [
                'upload_id' => $uploadId,
                'original_filename' => $originalFilename,
                'total_chunks' => $totalChunks,
                'object_name' => $objectName,
                'path_payload' => $pathPayload,
                'started_at' => time()
            ];
            file_put_contents($sessionDir . 'metadata.json', json_encode($metadata));
        }
        
        if (!file_exists($sessionDir)) {
            throw new Exception("Upload session not found. Please start from chunk 1.");
        }
        
        // Save chunk
        $chunkPath = $sessionDir . 'chunk_' . $chunkNumber;
        if (!move_uploaded_file($_FILES['file']['tmp_name'], $chunkPath)) {
            throw new Exception("Failed to save chunk $chunkNumber");
        }
        
        error_log("Saved chunk $chunkNumber to $chunkPath");
        
        // If not last chunk, return progress
        if (!$isLastChunk) {
            return [
                'success' => true,
                'message' => "Chunk $chunkNumber/$totalChunks uploaded successfully",
                'upload_id' => $uploadId,
                'chunk_number' => $chunkNumber,
                'total_chunks' => $totalChunks
            ];
        }
        
        // Last chunk - assemble and finalize
        return $this->assembleAndFinalize($uploadId, $sessionDir, $totalChunks);
    }
    
    /**
     * Assemble chunks and finalize upload
     */
    private function assembleAndFinalize($uploadId, $sessionDir, $totalChunks) {
        // Load metadata
        $metadataPath = $sessionDir . 'metadata.json';
        if (!file_exists($metadataPath)) {
            throw new Exception("Metadata not found");
        }
        
        $metadata = json_decode(file_get_contents($metadataPath), true);
        $originalFilename = $metadata['original_filename'];
        
        // Verify all chunks are present
        $missingChunks = [];
        for ($i = 1; $i <= $totalChunks; $i++) {
            if (!file_exists($sessionDir . 'chunk_' . $i)) {
                $missingChunks[] = $i;
            }
        }
        
        if (!empty($missingChunks)) {
            throw new Exception("Missing chunks: " . implode(', ', $missingChunks));
        }
        
        // Assemble chunks
        $assembledPath = $sessionDir . 'assembled_file';
        $assembledFile = fopen($assembledPath, 'wb');
        
        if (!$assembledFile) {
            throw new Exception("Failed to create assembled file");
        }
        
        for ($i = 1; $i <= $totalChunks; $i++) {
            $chunkPath = $sessionDir . 'chunk_' . $i;
            $chunkData = file_get_contents($chunkPath);
            fwrite($assembledFile, $chunkData);
        }
        
        fclose($assembledFile);
        
        error_log("Assembled file at $assembledPath");
        
        // Determine final filename
        $finalFilename = $originalFilename;
        if ($metadata['object_name']) {
            $finalFilename = basename($metadata['object_name']);
        } elseif ($metadata['path_payload']) {
            // Handle path payload if needed
            $finalFilename = $this->resolvePathWithPayload($metadata['path_payload'], $originalFilename);
        }
        
        // Move to final destination
        $finalPath = $this->uploadDir . $finalFilename;
        $finalDir = dirname($finalPath);
        
        if (!file_exists($finalDir)) {
            mkdir($finalDir, 0755, true);
        }
        
        if (!rename($assembledPath, $finalPath)) {
            throw new Exception("Failed to move assembled file to final destination");
        }
        
        error_log("Moved assembled file to $finalPath");
        
        // Cleanup
        $this->cleanupSession($sessionDir);
        
        // Generate response
        $fileUrl = $this->generateFileUrl($finalFilename);
        
        return [
            'success' => true,
            'message' => "File '$originalFilename' uploaded successfully via multipart upload.",
            's3_url' => $fileUrl,
            'file_url' => $fileUrl,
            'object_name' => $finalFilename,
            'source' => 'multipart_upload',
            'original_filename' => $originalFilename,
            'upload_id' => $uploadId,
            'total_chunks' => $totalChunks,
            'file_size' => filesize($finalPath)
        ];
    }
    
    /**
     * Handle regular single file upload
     */
    private function handleSingleUpload() {
        // Check if file was uploaded via POST
        if (isset($_POST['public_url'])) {
            return $this->handleUrlDownload($_POST['public_url']);
        }
        
        if (!isset($_FILES['file']) || $_FILES['file']['error'] !== UPLOAD_ERR_OK) {
            throw new Exception("No file uploaded or upload error");
        }
        
        $originalFilename = basename($_FILES['file']['name']);
        
        if (!$this->isValidFilename($originalFilename)) {
            throw new Exception("Invalid filename");
        }
        
        // Check file size
        if ($_FILES['file']['size'] > $this->maxFileSize) {
            throw new Exception("File size exceeds maximum allowed size");
        }
        
        // Determine final filename
        $finalFilename = $originalFilename;
        if (isset($_POST['object_name'])) {
            $finalFilename = basename($_POST['object_name']);
        } elseif (isset($_POST['path_payload'])) {
            $finalFilename = $this->resolvePathWithPayload($_POST['path_payload'], $originalFilename);
        }
        
        // Move file to final destination
        $finalPath = $this->uploadDir . $finalFilename;
        $finalDir = dirname($finalPath);
        
        if (!file_exists($finalDir)) {
            mkdir($finalDir, 0755, true);
        }
        
        if (!move_uploaded_file($_FILES['file']['tmp_name'], $finalPath)) {
            throw new Exception("Failed to move uploaded file");
        }
        
        $fileUrl = $this->generateFileUrl($finalFilename);
        
        return [
            'success' => true,
            'message' => "File '$originalFilename' uploaded successfully.",
            's3_url' => $fileUrl,
            'file_url' => $fileUrl,
            'object_name' => $finalFilename,
            'source' => 'file_upload',
            'original_filename' => $originalFilename,
            'file_size' => filesize($finalPath)
        ];
    }
    
    /**
     * Handle download from public URL
     */
    private function handleUrlDownload($publicUrl) {
        if (!filter_var($publicUrl, FILTER_VALIDATE_URL)) {
            throw new Exception("Invalid URL");
        }
        
        // Download file
        $context = stream_context_create([
            'http' => [
                'timeout' => 60,
                'user_agent' => 'PHP Multipart Upload Handler'
            ]
        ]);
        
        $tempFile = tempnam(sys_get_temp_dir(), 'url_download_');
        $content = file_get_contents($publicUrl, false, $context);
        
        if ($content === false) {
            throw new Exception("Failed to download file from URL");
        }
        
        file_put_contents($tempFile, $content);
        
        // Extract filename from URL
        $urlPath = parse_url($publicUrl, PHP_URL_PATH);
        $originalFilename = basename($urlPath);
        
        if (!$this->isValidFilename($originalFilename)) {
            $originalFilename = 'downloaded_file_' . time();
        }
        
        // Determine final filename
        $finalFilename = $originalFilename;
        if (isset($_POST['object_name'])) {
            $finalFilename = basename($_POST['object_name']);
        }
        
        // Move to final destination
        $finalPath = $this->uploadDir . $finalFilename;
        $finalDir = dirname($finalPath);
        
        if (!file_exists($finalDir)) {
            mkdir($finalDir, 0755, true);
        }
        
        if (!rename($tempFile, $finalPath)) {
            unlink($tempFile);
            throw new Exception("Failed to move downloaded file");
        }
        
        $fileUrl = $this->generateFileUrl($finalFilename);
        
        return [
            'success' => true,
            'message' => "File downloaded and uploaded successfully.",
            's3_url' => $fileUrl,
            'file_url' => $fileUrl,
            'object_name' => $finalFilename,
            'source' => 'public_url',
            'original_filename' => $originalFilename,
            'file_size' => filesize($finalPath)
        ];
    }
    
    /**
     * Abort multipart upload
     */
    private function abortUpload() {
        if (!isset($_POST['upload_id'])) {
            throw new Exception("Upload ID is required");
        }
        
        $uploadId = $this->sanitize($_POST['upload_id']);
        $sessionDir = $this->tempDir . $uploadId . '/';
        
        if (file_exists($sessionDir)) {
            $this->cleanupSession($sessionDir);
        }
        
        return [
            'success' => true,
            'message' => 'Upload aborted',
            'upload_id' => $uploadId
        ];
    }
    
    /**
     * Resolve path with payload (placeholder - implement based on your needs)
     */
    private function resolvePathWithPayload($pathPayload, $filename) {
        // Parse path payload
        $payload = is_string($pathPayload) ? json_decode($pathPayload, true) : $pathPayload;
        
        if (!$payload || !isset($payload['path_key'])) {
            return $filename;
        }
        
        // Example: you might call an external service here
        // For now, just create a simple path structure
        $basePath = $payload['path_key'] . '/';
        
        if (isset($payload['user_id'])) {
            $basePath .= $payload['user_id'] . '/';
        }
        
        return $basePath . $filename;
    }
    
    /**
     * Generate file URL
     */
    private function generateFileUrl($filename) {
        $protocol = isset($_SERVER['HTTPS']) && $_SERVER['HTTPS'] === 'on' ? 'https' : 'http';
        $host = $_SERVER['HTTP_HOST'];
        $baseUrl = $protocol . '://' . $host;
        
        // Remove document root from upload dir to get web path
        $webPath = str_replace($_SERVER['DOCUMENT_ROOT'], '', realpath($this->uploadDir));
        
        return $baseUrl . $webPath . '/' . $filename;
    }
    
    /**
     * Cleanup session directory
     */
    private function cleanupSession($sessionDir) {
        if (!file_exists($sessionDir)) {
            return;
        }
        
        // Remove all files in directory
        $files = glob($sessionDir . '*');
        foreach ($files as $file) {
            if (is_file($file)) {
                unlink($file);
            }
        }
        
        // Remove directory
        rmdir($sessionDir);
        
        error_log("Cleaned up session directory: $sessionDir");
    }
    
    /**
     * Validate filename
     */
    private function isValidFilename($filename) {
        // Check for dangerous characters
        if (preg_match('/[^a-zA-Z0-9._-]/', $filename)) {
            return false;
        }
        
        // Check extension
        $ext = strtolower(pathinfo($filename, PATHINFO_EXTENSION));
        return in_array($ext, $this->allowedExtensions);
    }
    
    /**
     * Sanitize string
     */
    private function sanitize($string) {
        return preg_replace('/[^a-zA-Z0-9_-]/', '', $string);
    }
    
    /**
     * Clean old sessions (call this periodically via cron)
     */
    public function cleanOldSessions($maxAge = 86400) {
        $dirs = glob($this->tempDir . '*/');
        $now = time();
        
        foreach ($dirs as $dir) {
            $metadataPath = $dir . 'metadata.json';
            if (file_exists($metadataPath)) {
                $metadata = json_decode(file_get_contents($metadataPath), true);
                if (isset($metadata['started_at']) && ($now - $metadata['started_at']) > $maxAge) {
                    $this->cleanupSession($dir);
                    error_log("Cleaned up old session: $dir");
                }
            }
        }
    }
}

// Usage example:
header('Content-Type: application/json');

// Initialize handler
$config = [
    'upload_dir' => __DIR__ . '/uploads/',
    'temp_dir' => sys_get_temp_dir() . '/multipart_uploads/',
    'max_file_size' => 5 * 1024 * 1024 * 1024, // 5GB
    'allowed_extensions' => ['mp4', 'mov', 'avi', 'mkv', 'webm', 'flv', 'jpg', 'png', 'pdf']
];

$handler = new MultipartUploadHandler($config);

try {
    $result = $handler->handleUpload();
    echo json_encode($result);
} catch (Exception $e) {
    http_response_code(500);
    echo json_encode([
        'success' => false,
        'error' => $e->getMessage()
    ]);
}

// Optional: Add a cron job to clean old sessions
// php upload.php cleanup
if (php_sapi_name() === 'cli' && isset($argv[1]) && $argv[1] === 'cleanup') {
    $handler->cleanOldSessions(86400); // Clean sessions older than 24 hours
    echo "Cleanup completed\n";
}
?>