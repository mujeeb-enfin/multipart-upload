import os
import uuid
import json
import tempfile
from typing import Optional, Dict
from fastapi import File, Form, UploadFile, HTTPException
import requests
import httpx
from pathlib import Path

# Add this dictionary to track multipart uploads (in production, use Redis or DB)
multipart_uploads: Dict[str, Dict] = {}

@router.post("/upload/")
async def upload_file(
    object_name: Optional[str] = None,
    public_url: Optional[str] = None,
    file: Optional[UploadFile] = File(None),
    path_payload: Optional[str] = Form(
        None,
        description="Optional JSON string to generate a base path; if provided, 'path_key' is mandatory"
    ),
    # New multipart parameters
    is_multipart: Optional[str] = Form(None, description="Set to 'true' for multipart upload"),
    upload_id: Optional[str] = Form(None, description="Unique ID for multipart upload session"),
    chunk_number: Optional[str] = Form(None, description="Current chunk number (1-based)"),
    total_chunks: Optional[str] = Form(None, description="Total number of chunks"),
    is_last_chunk: Optional[str] = Form(None, description="Set to 'true' for last chunk"),
    original_filename: Optional[str] = Form(None, description="Original filename for multipart upload"),
    abort_upload: Optional[str] = Form(None, description="Set to 'true' to abort multipart upload"),
):
    """
    Upload a file to object storage either from a file upload or by downloading from a public URL.
    Supports both regular uploads and multipart chunked uploads for large files.
    """
    print(settings.provider)
    bucket = settings.bucket_name
    
    # Handle multipart upload abort
    if abort_upload == 'true' and upload_id:
        cleanup_multipart_upload(upload_id)
        return {"message": "Upload aborted", "upload_id": upload_id}
    
    # Handle multipart upload
    if is_multipart == 'true':
        return await handle_multipart_upload(
            file=file,
            upload_id=upload_id,
            chunk_number=chunk_number,
            total_chunks=total_chunks,
            is_last_chunk=is_last_chunk,
            original_filename=original_filename,
            object_name=object_name,
            path_payload=path_payload,
            bucket=bucket
        )
    
    # Regular upload logic (existing code)
    if not file and not public_url:
        raise HTTPException(status_code=400, detail="Either 'file' or 'public_url' must be provided")

    if file and public_url:
        raise HTTPException(status_code=400, detail="Cannot provide both 'file' and 'public_url'. Choose one.")

    temp_path = None
    filename = None
    original_filename = None

    try:
        storage = ObjectStorageFactory.get_storage_provider(
            provider=settings.provider,
            **settings.dict(exclude={"provider"})
        )

        # Download from URL branch
        if public_url:
            logger.info(f"Downloading file from public URL: {public_url}")
            filename, original_filename = get_safe_filename_from_url(public_url)
            temp_filename = f"{uuid.uuid4().hex}_{filename}"
            temp_path = f"/tmp/{temp_filename}" # NOSONAR
            logger.info(f"Using safe filename: {filename} (original: {original_filename})")

            try:
                resp = requests.get(public_url, stream=True, timeout=30) # NOSONAR
                resp.raise_for_status()
                with open(temp_path, "wb") as buffer: # NOSONAR
                    for chunk in resp.iter_content(chunk_size=8192):
                        if chunk:
                            buffer.write(chunk)
                logger.info(f"Successfully downloaded file from {public_url} to {temp_path}")
            except requests.exceptions.RequestException as e:
                logger.error(f"Failed to download file from {public_url}: {str(e)}")
                raise HTTPException(status_code=400, detail=f"Failed to download file from URL: {str(e)}")

        # File upload branch
        else:
            filename = file.filename
            original_filename = file.filename
            logger.info(f"Uploading file {filename} to bucket {bucket} as {object_name}")
            temp_filename = f"{uuid.uuid4().hex}_{filename}"
            temp_path = f"/tmp/{temp_filename}" # NOSONAR
            
            with open(temp_path, "wb") as buffer: # NOSONAR
                buffer.write(file.file.read())

        # Compute full_object_name (maybe with path service)
        full_object_name = object_name

        if path_payload:
            full_object_name = await resolve_path_with_service(
                path_payload, original_filename
            )

        # Upload to storage
        logger.info(f"Uploading {filename} to bucket {bucket} as {full_object_name}")
        storage.upload_file(bucket, temp_path, full_object_name)

        # Clean up temp
        if os.path.exists(temp_path):
            os.remove(temp_path)

        response_url = generate_response_url(bucket, full_object_name)
        return {
            "message": f"File '{original_filename}' uploaded successfully.",
            "s3_url": response_url,
            "object_name": full_object_name,
            "source": "public_url" if public_url else "file_upload",
            "original_filename": original_filename,
            "safe_filename": filename if public_url else original_filename
        }

    except HTTPException:
        if temp_path and os.path.exists(temp_path):
            os.remove(temp_path)
        raise
    except Exception as e:
        if temp_path and os.path.exists(temp_path):
            os.remove(temp_path)
        logger.error(f"Error uploading file: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Upload failed: {str(e)}")


async def handle_multipart_upload(
    file: UploadFile,
    upload_id: str,
    chunk_number: str,
    total_chunks: str,
    is_last_chunk: str,
    original_filename: str,
    object_name: Optional[str],
    path_payload: Optional[str],
    bucket: str
):
    """
    Handle multipart upload chunks
    """
    try:
        chunk_num = int(chunk_number)
        total = int(total_chunks)
        is_last = is_last_chunk == 'true'
        
        logger.info(f"Multipart upload: {upload_id}, chunk {chunk_num}/{total}")
        
        # Initialize upload session if first chunk
        if chunk_num == 1:
            temp_dir = tempfile.mkdtemp(prefix=f"upload_{upload_id}_")
            multipart_uploads[upload_id] = {
                'temp_dir': temp_dir,
                'chunks': {},
                'total_chunks': total,
                'original_filename': original_filename,
                'object_name': object_name,
                'path_payload': path_payload
            }
            logger.info(f"Initialized multipart upload session: {upload_id} at {temp_dir}")
        
        # Validate upload session exists
        if upload_id not in multipart_uploads:
            raise HTTPException(
                status_code=400, 
                detail=f"Upload session {upload_id} not found. Please start from chunk 1."
            )
        
        upload_session = multipart_uploads[upload_id]
        
        # Save chunk to temp file
        chunk_path = os.path.join(upload_session['temp_dir'], f"chunk_{chunk_num}")
        with open(chunk_path, "wb") as buffer:
            content = await file.read()
            buffer.write(content)
        
        upload_session['chunks'][chunk_num] = chunk_path
        logger.info(f"Saved chunk {chunk_num} to {chunk_path}, size: {len(content)} bytes")
        
        # If not last chunk, return progress
        if not is_last:
            return {
                "message": f"Chunk {chunk_num}/{total} uploaded successfully",
                "upload_id": upload_id,
                "chunk_number": chunk_num,
                "total_chunks": total,
                "chunks_received": len(upload_session['chunks'])
            }
        
        # Last chunk - assemble and upload
        logger.info(f"Last chunk received, assembling file for upload {upload_id}")
        
        # Verify all chunks are present
        missing_chunks = []
        for i in range(1, total + 1):
            if i not in upload_session['chunks']:
                missing_chunks.append(i)
        
        if missing_chunks:
            raise HTTPException(
                status_code=400,
                detail=f"Missing chunks: {missing_chunks}. Received {len(upload_session['chunks'])}/{total}"
            )
        
        # Assemble chunks into final file
        final_temp_path = os.path.join(upload_session['temp_dir'], "assembled_file")
        with open(final_temp_path, "wb") as final_file:
            for i in range(1, total + 1):
                chunk_path = upload_session['chunks'][i]
                with open(chunk_path, "rb") as chunk_file:
                    final_file.write(chunk_file.read())
        
        logger.info(f"Assembled file at {final_temp_path}")
        
        # Get storage provider
        storage = ObjectStorageFactory.get_storage_provider(
            provider=settings.provider,
            **settings.dict(exclude={"provider"})
        )
        
        # Determine final object name
        full_object_name = object_name
        if path_payload:
            full_object_name = await resolve_path_with_service(
                path_payload, 
                original_filename
            )
        elif not full_object_name:
            full_object_name = original_filename
        
        # Upload to storage
        logger.info(f"Uploading assembled file to bucket {bucket} as {full_object_name}")
        storage.upload_file(bucket, final_temp_path, full_object_name)
        
        # Generate response URL
        response_url = generate_response_url(bucket, full_object_name)
        
        # Cleanup
        cleanup_multipart_upload(upload_id)
        
        return {
            "message": f"File '{original_filename}' uploaded successfully via multipart upload.",
            "s3_url": response_url,
            "object_name": full_object_name,
            "source": "multipart_upload",
            "original_filename": original_filename,
            "upload_id": upload_id,
            "total_chunks": total
        }
        
    except HTTPException:
        cleanup_multipart_upload(upload_id)
        raise
    except Exception as e:
        logger.error(f"Error in multipart upload: {str(e)}")
        cleanup_multipart_upload(upload_id)
        raise HTTPException(status_code=500, detail=f"Multipart upload failed: {str(e)}")


async def resolve_path_with_service(path_payload: str, filename: str) -> str:
    """
    Resolve path using path service
    """
    try:
        payload_dict = json.loads(path_payload)
        payload_obj = PathPayload(**payload_dict)
        
        if not payload_obj.path_key:
            raise HTTPException(status_code=400, detail="path_key is mandatory when path_payload is provided")
        
    except json.JSONDecodeError as e:
        raise HTTPException(status_code=400, detail=f"Invalid JSON in path_payload: {str(e)}")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=f"Invalid path_payload format: {str(e)}")

    if not hasattr(settings, "path_service_url") or not settings.path_service_url:
        raise HTTPException(status_code=500, detail="Path service URL is not configured")

    payload_json = payload_obj.model_dump(exclude_none=True)

    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            path_resp = await client.post(settings.path_service_url, json=payload_json)
        
        if path_resp.status_code != 200:
            raise HTTPException(
                status_code=path_resp.status_code,
                detail=f"Path service failed with {path_resp.status_code}: {path_resp.text}"
            )
        
        data = path_resp.json()
        path_from_service = data.get("path")
        if not path_from_service:
            raise HTTPException(status_code=500, detail="Path service response missing 'path' field")

        return join_posix(path_from_service, filename)

    except httpx.RequestError as e:
        logger.error(f"Path service unreachable: {e}")
        raise HTTPException(status_code=502, detail="Could not reach path service")
    except httpx.HTTPStatusError as e:
        logger.error(f"Path service error: {e}")
        raise HTTPException(status_code=502, detail="Path service returned an error")


def cleanup_multipart_upload(upload_id: str):
    """
    Cleanup temporary files for a multipart upload
    """
    if upload_id in multipart_uploads:
        upload_session = multipart_uploads[upload_id]
        temp_dir = upload_session.get('temp_dir')
        
        if temp_dir and os.path.exists(temp_dir):
            try:
                import shutil
                shutil.rmtree(temp_dir)
                logger.info(f"Cleaned up temp directory: {temp_dir}")
            except Exception as e:
                logger.error(f"Failed to cleanup temp directory {temp_dir}: {str(e)}")
        
        del multipart_uploads[upload_id]
        logger.info(f"Removed upload session: {upload_id}")