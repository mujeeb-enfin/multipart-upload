/**
 * Uploads a large video file in multiple parts using your existing endpoint
 * @param {File} file - The video file to upload
 * @param {Object} options - Upload configuration options
 * @param {string} options.uploadUrl - Your upload endpoint URL
 * @param {number} options.chunkSize - Size of each chunk in bytes (default: 5MB)
 * @param {Function} options.onProgress - Progress callback (percentage)
 * @param {Function} options.onChunkComplete - Called after each chunk upload
 * @param {Object} options.headers - Additional headers for requests
 * @param {string} options.objectName - Optional object name for storage
 * @param {Object} options.pathPayload - Optional path payload for dynamic path generation
 * @returns {Promise<Object>} Upload result with file metadata
 */
async function uploadVideoMultipart(file, options = {}) {
  const {
    uploadUrl,
    chunkSize = 5 * 1024 * 1024, // 5MB default
    onProgress = () => {},
    onChunkComplete = () => {},
    headers = {},
    objectName = null,
    pathPayload = null
  } = options;

  if (!file) {
    throw new Error('No file provided');
  }

  if (!uploadUrl) {
    throw new Error('Upload URL is required');
  }

  const totalChunks = Math.ceil(file.size / chunkSize);
  const uploadId = generateUploadId();
  
  console.log(`Starting multipart upload: ${file.name}`);
  console.log(`File size: ${(file.size / (1024 * 1024)).toFixed(2)} MB`);
  console.log(`Total chunks: ${totalChunks}`);

  try {
    // Upload chunks sequentially
    const uploadedChunks = [];
    
    for (let i = 0; i < totalChunks; i++) {
      const start = i * chunkSize;
      const end = Math.min(start + chunkSize, file.size);
      const chunk = file.slice(start, end);
      
      const chunkNumber = i + 1;
      const isLastChunk = chunkNumber === totalChunks;
      
      const formData = new FormData();
      formData.append('file', chunk, file.name);
      
      // Multipart-specific parameters
      formData.append('is_multipart', 'true');
      formData.append('upload_id', uploadId);
      formData.append('chunk_number', chunkNumber.toString());
      formData.append('total_chunks', totalChunks.toString());
      formData.append('is_last_chunk', isLastChunk.toString());
      formData.append('original_filename', file.name);
      
      // Optional parameters
      if (objectName) {
        formData.append('object_name', objectName);
      }
      
      if (pathPayload) {
        formData.append('path_payload', JSON.stringify(pathPayload));
      }

      let retries = 3;
      let uploaded = false;
      let chunkResult = null;

      while (retries > 0 && !uploaded) {
        try {
          const uploadResponse = await fetch(uploadUrl, {
            method: 'POST',
            headers: {
              ...headers
              // Don't set Content-Type, let browser set it with boundary for FormData
            },
            body: formData
          });

          if (!uploadResponse.ok) {
            const errorText = await uploadResponse.text();
            throw new Error(`Chunk ${chunkNumber} upload failed: ${errorText}`);
          }

          chunkResult = await uploadResponse.json();
          uploadedChunks.push({
            chunkNumber,
            ...chunkResult
          });
          uploaded = true;

          // Progress callback
          const progress = Math.round((chunkNumber / totalChunks) * 100);
          onProgress(progress);
          onChunkComplete(chunkNumber, totalChunks);

          console.log(`Uploaded chunk ${chunkNumber}/${totalChunks} (${progress}%)`);

        } catch (error) {
          retries--;
          console.warn(`Retry chunk ${chunkNumber}, attempts left: ${retries}`);
          
          if (retries === 0) {
            throw new Error(`Failed to upload chunk ${chunkNumber} after retries: ${error.message}`);
          }
          
          // Wait before retry with exponential backoff
          await new Promise(resolve => setTimeout(resolve, 1000 * (4 - retries)));
        }
      }

      // If this was the last chunk, return the final result
      if (isLastChunk && chunkResult) {
        console.log('Upload completed successfully!');
        return {
          success: true,
          uploadId,
          fileName: file.name,
          fileSize: file.size,
          totalChunks,
          ...chunkResult
        };
      }
    }

  } catch (error) {
    console.error('Upload failed:', error);
    
    // Attempt to cleanup/abort the upload
    try {
      const formData = new FormData();
      formData.append('is_multipart', 'true');
      formData.append('upload_id', uploadId);
      formData.append('abort_upload', 'true');
      
      await fetch(uploadUrl, {
        method: 'POST',
        headers: {
          ...headers
        },
        body: formData
      });
    } catch (abortError) {
      console.error('Failed to abort upload:', abortError);
    }

    throw error;
  }
}

/**
 * Regular single-file upload (non-chunked)
 */
async function uploadVideoSingle(file, options = {}) {
  const {
    uploadUrl,
    headers = {},
    objectName = null,
    pathPayload = null,
    publicUrl = null,
    onProgress = () => {}
  } = options;

  if (!file && !publicUrl) {
    throw new Error('Either file or publicUrl must be provided');
  }

  const formData = new FormData();
  
  if (file) {
    formData.append('file', file);
  }
  
  if (publicUrl) {
    formData.append('public_url', publicUrl);
  }
  
  if (objectName) {
    formData.append('object_name', objectName);
  }
  
  if (pathPayload) {
    formData.append('path_payload', JSON.stringify(pathPayload));
  }

  try {
    const response = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        ...headers
      },
      body: formData
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Upload failed: ${errorText}`);
    }

    onProgress(100);
    const result = await response.json();
    
    return {
      success: true,
      ...result
    };

  } catch (error) {
    console.error('Upload failed:', error);
    throw error;
  }
}

/**
 * Generates a unique upload ID
 */
function generateUploadId() {
  return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Smart upload function that chooses between single and multipart upload
 * based on file size
 */
async function uploadVideo(file, options = {}) {
  const { 
    multipartThreshold = 10 * 1024 * 1024, // 10MB threshold
    ...restOptions 
  } = options;

  if (file && file.size > multipartThreshold) {
    console.log('Using multipart upload for large file');
    return uploadVideoMultipart(file, restOptions);
  } else {
    console.log('Using single upload for small file');
    return uploadVideoSingle(file, restOptions);
  }
}



document.getElementById("uploadBtn").addEventListener("click", async () => {
    const fileInput = document.getElementById("fileInput");
    const videoFile = fileInput.files[0];
    uploadVideo(videoFile, {
        uploadUrl: 'https://yourdomain.com/api/upload',
        multipartThreshold: 10 * 1024 * 1024, // 10MB
        chunkSize: 5 * 1024 * 1024, // 5MB chunks
        objectName: 'videos/my-video.mp4',
        // pathPayload: {
        //     path_key: 'user_uploads',
        //     user_id: 'd5b8e93b-a7a5-4ef6-aaae-f7d9fb455b2e',
        //     tenant_id: '62f3b0d8-a68d-4765-9183-a71459c63ae2'
        // },
        headers: {
            'Authorization': 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.hjdsfgsddsshgfshgfgdhgfggttuteurbx gvcjbxvvjghjghgdsjgfhgdshgfhgdshfhsgjfjsg.06hVOOx2OL5ayLNxUNK2PIy5A-KF_g6q8m9qVY40Z8c'
        },

        onProgress: (percent) => {
          progressBar.value = percent;
          progressText.textContent = `Uploading... ${percent}%`;
        },
        onChunkComplete: (curr, total) =>
          console.log(`Completed chunk ${curr}/${total}`),
    }).then(result => {
        console.log('Upload successful:', result);
        console.log('File URL:', result.s3_url);
    }).catch(error => {
        console.error('Upload failed:', error);
        alert('Upload failed: ' + error.message);
    });
});

/*
// Force multipart upload
uploadVideoMultipart(videoFile, {
  uploadUrl: '/upload/',
  chunkSize: 5 * 1024 * 1024,
  onProgress: (percent) => console.log(`${percent}%`)
});

// Force single upload
uploadVideoSingle(videoFile, {
  uploadUrl: '/upload/',
  objectName: 'my-file.mp4'
});
*/