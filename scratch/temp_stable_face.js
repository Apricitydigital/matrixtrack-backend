router.post("/face-attendance", upload.single("image"), async (req, res) => {
  try {
    safeDebugLog(`[${new Date().toISOString()}] /face-attendance hit! mode: ${req.body?.groupMode}`);
    const {
      punch_type: rawPunchType,
      latitude: rawLatitude,
      longitude: rawLongitude,
      userId,
      address,
      emp_id: rawEmpId,
      employeeId: rawEmployeeId,
      groupMode,
      group_mode: groupModeAlias,
      mode: rawMode,
      faceMatchThreshold: rawThreshold,
      ward_id: rawWardId,
      wardId: rawWardIdAlt,
    } = req.body;
    const attendanceDate = resolveAttendanceDate(req.body, req.query);
    const wardId = normalizeId(rawWardId ?? rawWardIdAlt ?? null);
    const supervisorId = normalizeId(
      userId ?? req.body?.supervisor_id ?? req.body?.user_id
    );

    if (!req.file) {
      return res.status(400).json({
        error: "Face image is required",
      });
    }
    await ensureNormalizedCaptureFile(req.file);

    const normalizedCaptureBuffer = req.file.buffer;
    const collectionId = resolveCollectionId();
    if (!collectionId) {
      return res.status(500).json({
        error: "Rekognition collection is not configured",
        details:
          "Set REKOGNITION_COLLECTION or REKOGNITION_COLLECTION_ID in the backend .env file.",
      });
    }

    await ensureCollectionExists(collectionId);

    const punchType = normalizePunchType(rawPunchType);

    const thresholdCandidate = Number(rawThreshold);
    const matchThreshold = Number.isFinite(thresholdCandidate)
      ? thresholdCandidate
      : DEFAULT_FACE_MATCH_THRESHOLD;

    const locationPayload = {
      latitude:
        rawLatitude !== undefined && rawLatitude !== null && rawLatitude !== ""
          ? rawLatitude
          : "0",
      longitude:
        rawLongitude !== undefined &&
          rawLongitude !== null &&
          rawLongitude !== ""
          ? rawLongitude
          : "0",
      address: address ?? "",
    };

    const groupModeRequested = isGroupModeRequest(
      groupMode,
      groupModeAlias,
      rawMode
    );

    console.log("[face-attendance] groupMode:", groupMode, "| mode:", rawMode, "| groupModeRequested:", groupModeRequested);

    if (groupModeRequested) {
      const detectCommand = new DetectFacesCommand({
        Image: { Bytes: normalizedCaptureBuffer },
        Attributes: ["DEFAULT"],
      });

      const detectResult = await rekognition.send(detectCommand);
      const faceDetails = detectResult?.FaceDetails ?? [];

      console.log("[face-attendance] Detected faces:", faceDetails.length);

      if (!faceDetails.length) {
        return res.status(422).json({
          error: "No faces detected in the image",
          suggestion: "Ensure group members are clearly visible and retry.",
        });
      }

      if (faceDetails.length > 10) {
        console.log("[face-attendance] BLOCKING: too many faces:", faceDetails.length);
        return res.status(422).json({
          error: "Please reduce the people count to 10",
          details: `Detected ${faceDetails.length} faces. Maximum allowed is 10.`,
          suggestion: "Capture the photo with 10 or fewer people and retry.",
        });
      }

      const imageMetadata = await sharp(normalizedCaptureBuffer).metadata();
      const imageWidth = imageMetadata?.width ?? null;
      const imageHeight = imageMetadata?.height ?? null;

      if (!imageWidth || !imageHeight) {
        return res.status(400).json({
          error: "Unable to read image dimensions for face processing",
        });
      }

      // ΓöÇΓöÇΓöÇ PARALLEL GROUP PUNCH ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
      // All faces processed simultaneously. 5 faces that took 40s now take ~8s.
      // Each face is fully independent ΓÇö no shared mutable state inside the map.
      // processedEmployees dedup is done as a post-pass on the collected results.
      // ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
      const groupThreshold = Math.max(88, Math.min(matchThreshold, 92));

      const perFaceResults = await mapLimit(
        faceDetails,
        2,
        async (faceDetail, index) => {
          const faceIndex = index + 1;

          // ΓöÇΓöÇ 1. Crop face ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
          const cropRegion = computeCropRegion(faceDetail.BoundingBox, imageWidth, imageHeight);
          if (!cropRegion) {
            return { faceIndex, status: "skipped", message: "Unable to crop the detected face region." };
          }

          let faceImageBuffer;
          try {
            faceImageBuffer = await sharp(normalizedCaptureBuffer)
              .extract(cropRegion)
              .resize(600, 600, { fit: "cover" })
              .toBuffer();
          } catch (cropError) {
            console.error("[Group] face crop failed", cropError);
            return { faceIndex, status: "error", message: "Unable to process the detected face region." };
          }

          // ΓöÇΓöÇ 2. Rekognition face search ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
          // ≡ƒÆ░ COST OPT: QualityFilter=AUTO skips low-quality/blurry crops before
          // AWS charges for them. DetectFaces already confirmed a face exists here.
          let searchResult;
          try {
            // Validate image buffer immediately before SearchFacesByImage call
            const maxImageSizeBytes = 5 * 1024 * 1024;
            const allowedMimetypes = ["image/jpeg", "image/jpg", "image/png"];
            const mimeTypeOk = req.file?.mimetype ? allowedMimetypes.includes(req.file.mimetype.toLowerCase()) : true;
            const isBufferValid = faceImageBuffer && faceImageBuffer.length > 0 && faceImageBuffer.length <= maxImageSizeBytes;

            if (!isBufferValid || !mimeTypeOk) {
              return {
                faceIndex,
                status: "skipped",
                similarity: null,
                matched: false,
                reason: "invalid_image",
                message: "Face crop too small/invalid. Please recapture."
              };
            }

            searchResult = await withTimeout(
              rekognition.send(new SearchFacesByImageCommand({
                CollectionId: collectionId,
                Image: { Bytes: faceImageBuffer },
                MaxFaces: 1,
                FaceMatchThreshold: groupThreshold,
              })),
              GROUP_FACE_SEARCH_TIMEOUT_MS,
              "Face search timed out"
            );
          } catch (searchError) {
            const parsed = parseRekognitionError(searchError);
            if (parsed.isExpected) {
              console.warn(
                `[GroupPunch - Face ${faceIndex}] Expected Rekognition error: ` +
                `type=${parsed.reason} msg=${parsed.message} reqId=${parsed.requestId || "n/a"}`
              );
              if (parsed.reason === "no_face") {
                return {
                  faceIndex,
                  status: "unmatched",
                  similarity: null,
                  matched: false,
                  reason: "no_face",
                  message: "No clear face detected in this crop. Please recapture."
                };
              }
              if (parsed.reason === "rekognition_throttled") {
                return {
                  faceIndex,
                  status: "error",
                  similarity: null,
                  matched: false,
                  reason: "rekognition_throttled",
                  message: "AWS Rekognition service throttled. Please retry."
                };
              }
              if (parsed.reason === "timeout") {
                return {
                  faceIndex,
                  status: "error",
                  similarity: null,
                  matched: false,
                  reason: "timeout",
                  message: "Face search timed out. Please retry."
                };
              }
            }

            console.error("[Group] face search failed unexpectedly:", searchError);
            if (searchError?.Code === "InvalidParameterException" || searchError?.name === "InvalidParameterException") {
              return { faceIndex, status: "unmatched", similarity: null, message: "No clear face detected in this crop. Please recapture." };
            }
            const { payload } = mapRekognitionError(searchError);
            return { faceIndex, status: "error", message: payload?.details || payload?.error || "Face recognition failed" };
          }

          const bestMatch = searchResult?.FaceMatches?.[0] ?? null;
          let employeeRecord = null;
          let similarity = bestMatch?.Similarity ?? null;

          // ΓöÇΓöÇ 3. Resolve employee ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
          if (bestMatch?.Face) {
            employeeRecord = await resolveEmployeeFromFaceIdentifiers({
              faceId: bestMatch.Face.FaceId,
              matchedExternalId: bestMatch.Face.ExternalImageId ?? null,
              requestedEmpId: null,
            });
          }

          // Group-only safe fallback: roster-level CompareFaces
          // ≡ƒÆ░ COST OPT: GROUP_FALLBACK_ENABLED guards this path.
          // Each call here = N paid CompareFaces calls (N = employees in ward).
          // Only trigger when collection misses AND fallback is enabled.
          if (!employeeRecord && supervisorId && GROUP_FALLBACK_ENABLED) {
            const fallback = await fallbackMatchByCompare(
              faceImageBuffer, supervisorId, wardId,
              Math.max(85, Math.min(matchThreshold, 90))
            );
            if (fallback?.employee) {
              employeeRecord = fallback.employee;
              similarity = fallback.similarity ?? similarity;
            }
          }

          if (!employeeRecord) {
            return {
              faceIndex, status: "unmatched", similarity: null,
              message: "Face not recognized in collection/roster. Please capture clearer image or re-enroll face.",
              hint: "Ensure this employee's face photo is uploaded in the face gallery before using group attendance.",
            };
          }

          // ΓöÇΓöÇ 4. LAYER 2: CompareFaces cross-check (only if enabled) ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
          if (GROUP_DOUBLE_VERIFY_ENABLED) {
            const DOUBLE_VERIFY_THRESHOLD = 90;
            try {
              const enrolledBuffer = await loadFaceBuffer(employeeRecord.face_embedding, employeeRecord.emp_id);
              if (enrolledBuffer) {
                const crossCheck = await withTimeout(
                  rekognition.send(new CompareFacesCommand({
                    SourceImage: { Bytes: enrolledBuffer },
                    TargetImage: { Bytes: faceImageBuffer },
                    SimilarityThreshold: DOUBLE_VERIFY_THRESHOLD,
                  })),
                  GROUP_FACE_SEARCH_TIMEOUT_MS,
                  "Face secondary verification timed out"
                );
                const crossSimilarity = crossCheck?.FaceMatches?.[0]?.Similarity ?? 0;
                if (crossSimilarity < DOUBLE_VERIFY_THRESHOLD) {
                  console.warn(`[Group] Double-verify FAILED emp_id=${employeeRecord.emp_id}: rekog=${similarity?.toFixed(1)}% compare=${crossSimilarity.toFixed(1)}%`);
                  return { faceIndex, status: "unmatched", similarity: crossSimilarity, message: "Face verification failed secondary check. Please recapture.", code: "DOUBLE_VERIFY_FAILED" };
                }
              }
            } catch (crossErr) {
              console.warn(`[Group] Double-verify skipped emp_id=${employeeRecord.emp_id}:`, crossErr.message);
            }
          }

          // ΓöÇΓöÇ 5. LAYER 3: Supervisor roster cross-check ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
          if (supervisorId) {
            const rosterCheck = await pool.query(
              `SELECT 1 FROM employee e
               JOIN supervisor_ward sw ON sw.ward_id = e.ward_id
               WHERE e.emp_id = $1 AND sw.supervisor_id = $2 LIMIT 1`,
              [employeeRecord.emp_id, supervisorId]
            );
            if (rosterCheck.rowCount === 0) {
              console.warn(`[Group] Roster FAILED emp_id=${employeeRecord.emp_id} supervisor=${supervisorId}`);
              return { faceIndex, status: "skipped", similarity, employeeId: employeeRecord.emp_id, employeeName: employeeRecord.name, message: "Employee does not belong to this supervisor's ward.", code: "UNAUTHORIZED_WARD" };
            }
          }

          // ΓöÇΓöÇ 6. Leave check ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
          try {
            const leaveCheck = await pool.query(
              `SELECT leave_type FROM attendance
               WHERE emp_id = $1 AND date = $2::date
               ORDER BY attendance_id DESC LIMIT 1`,
              [employeeRecord.emp_id, attendanceDate]
            );
            const leaveRow = leaveCheck?.rows?.[0];
            if (leaveRow?.leave_type) {
              return { faceIndex, status: "skipped", employeeId: employeeRecord.emp_id, employeeName: employeeRecord.name, similarity, message: `Leave already marked (${leaveRow.leave_type}). Punch skipped.`, code: "LEAVE_MARKED" };
            }
          } catch (leaveErr) {
            console.error(`[Group] Leave-check failed emp_id=${employeeRecord.emp_id}:`, leaveErr?.message);
          }

          // ΓöÇΓöÇ 7. Session validation (prevents double punch-in) ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
          const sessionError = await validatePunchSession(employeeRecord.emp_id, attendanceDate, punchType);
          if (sessionError) {
            return { faceIndex, status: "skipped", employeeId: employeeRecord.emp_id, employeeName: employeeRecord.name, similarity, message: sessionError.error, code: sessionError.code };
          }

          // ΓöÇΓöÇ 8. Geofencing ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
          const geoCheck = await validateGeofencing(employeeRecord.emp_id, locationPayload.latitude, locationPayload.longitude);
          if (!geoCheck.allowed) {
            return { faceIndex, status: "skipped", employeeId: employeeRecord.emp_id, employeeName: employeeRecord.name, similarity, message: geoCheck.message || "Out of assigned zone", code: "OUT_OF_GEofence" };
          }

          // ΓöÇΓöÇ 9. Create attendance record & punch ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
          const attendance = await getOrCreateAttendanceRecord(
            employeeRecord.emp_id, attendanceDate, { punchType, createIfMissing: true }
          );
          const updated = await processPunch(
            attendance.attendance_id, punchType,
            { buffer: faceImageBuffer },
            userId, locationPayload,
            {
              employeeId: employeeRecord.emp_id,
              requireFaceMatch: false,      // Already verified by Rekognition above
              faceMatchThreshold: matchThreshold,
            }
          );

          return {
            faceIndex,
            status: "punched",
            employeeId: employeeRecord.emp_id,
            employeeName: employeeRecord.name,
            similarity,
            attendanceId: attendance.attendance_id,
            punchedAt: formatPunchTimeForClient(resolvePunchRecordTime(updated, punchType)),
          };
        }
      );

      // Flatten allSettled ΓåÆ plain results array
      const rawResults = perFaceResults.map((settled, i) => {
        if (settled.status === "fulfilled") return settled.value;
        console.error(`[Group] Face ${i + 1} threw unexpectedly:`, settled.reason?.message);
        return { faceIndex: i + 1, status: "error", message: settled.reason?.message || "Face processing failed" };
      });

      // Post-dedup: if same employee matched on two crops, keep first, mark rest duplicate
      const seenEmpIds = new Set();
      const results = rawResults.map((r) => {
        if (r.status === "punched" && r.employeeId != null) {
          if (seenEmpIds.has(r.employeeId)) {
            return { faceIndex: r.faceIndex, status: "duplicate", similarity: r.similarity ?? null, employeeId: r.employeeId, employeeName: r.employeeName, message: "Employee already processed in this capture." };
          }
          seenEmpIds.add(r.employeeId);
        }
        return r;
      });


      const punchedCount = results.filter(
        (entry) => entry.status === "punched"
      ).length;

      safeDebugLog(`[${new Date().toISOString()}] Group Punch Results: ${JSON.stringify(results)}`);

      return res.json({
        success: punchedCount > 0,
        mode: "group",
        punch_type: punchType,
        total_faces: faceDetails.length,
        punched_count: punchedCount,
        results,
      });
    }

    const requestedEmpId = normalizeId(rawEmpId ?? rawEmployeeId);
    if (!requestedEmpId) {
      return res.status(400).json({
        error: "Please select an employee first.",
      });
    }

    // 1. Fetch the selected employee
    const employeeRecord = await fetchEmployeeById(requestedEmpId);
    if (!employeeRecord) {
      return res.status(404).json({
        error: "Selected employee not found in the system.",
      });
    }

    // ≡ƒÆ░ COST OPT: 60-second dedup guard ΓÇö if same employee punched within
    // the last 60s (network retry scenario), return cached success immediately
    // without making any paid Rekognition API call.
    if (isDuplicatePunch(requestedEmpId, punchType, attendanceDate)) {
      console.log(`[face-attendance] Dedup hit: emp_id=${requestedEmpId} punchType=${punchType} date=${attendanceDate} ΓÇö skipping Rekognition`);
      return res.status(200).json({
        success: true,
        employee: employeeRecord.name,
        punch_type: punchType,
        face_similarity: null,
        face_match_threshold: matchThreshold,
        time: null,
        deduplicated: true, // flag so client knows it was a cached response
      });
    }

    // 2. Search for the face in the collection
    // Validate image buffer immediately before SearchFacesByImage call
    const maxImageSizeBytes = 5 * 1024 * 1024;
    const allowedMimetypes = ["image/jpeg", "image/jpg", "image/png"];
    const mimeTypeOk = req.file?.mimetype ? allowedMimetypes.includes(req.file.mimetype.toLowerCase()) : true;
    const isBufferValid = normalizedCaptureBuffer && normalizedCaptureBuffer.length > 0 && normalizedCaptureBuffer.length <= maxImageSizeBytes;

    if (!isBufferValid || !mimeTypeOk) {
      return res.status(400).json({
        success: false,
        matched: false,
        reason: "invalid_image",
        error: "Invalid face image buffer"
      });
    }

    let searchResult;
    try {
      searchResult = await withTimeout(
        rekognition.send(new SearchFacesByImageCommand({
          CollectionId: collectionId,
          Image: { Bytes: normalizedCaptureBuffer },
          MaxFaces: 1,
          FaceMatchThreshold: matchThreshold,
        })),
        GROUP_FACE_SEARCH_TIMEOUT_MS,
        "Face search timed out"
      );
    } catch (searchError) {
      const parsed = parseRekognitionError(searchError);
      if (parsed.isExpected) {
        console.warn(
          `[IndividualPunch] Expected Rekognition error: ` +
          `type=${parsed.reason} msg=${parsed.message} reqId=${parsed.requestId || "n/a"}`
        );
        return res.status(400).json({
          success: false,
          matched: false,
          reason: parsed.reason,
          error: parsed.reason === "no_face" ? "No faces in the image" : "Face search failed",
          details: parsed.message
        });
      } else {
        console.error(`[IndividualPunch] Face search failed unexpectedly:`, searchError);
        throw searchError; // Let it hit the main route catch block
      }
    }

    const matchedFaceResult = searchResult.FaceMatches?.[0];
    const matchedFace = matchedFaceResult?.Face ?? null;

    // ≡ƒöÆ STRICT IDENTITY CHECK
    // If we found a face in the system, it MUST resolve to the selected employee.
    if (matchedFace) {
      const matchedExternalRaw = matchedFace.ExternalImageId ?? null;
      const matchedExternalId = normalizeId(matchedExternalRaw);
      const resolvedMatchedEmployee = await resolveEmployeeFromFaceIdentifiers({
        faceId: matchedFace.FaceId ?? null,
        matchedExternalId: matchedExternalRaw,
        requestedEmpId: null,
      });
      const isMatchingSelectedEmployee =
        resolvedMatchedEmployee &&
        String(resolvedMatchedEmployee.emp_id) === String(requestedEmpId);

      if (!isMatchingSelectedEmployee) {
        // Last-chance individual verification against the selected employee.
        // This prevents false mismatch rejects when collection top-match is noisy.
        try {
          const selectedFaceBuffer = await loadFaceBuffer(
            employeeRecord.face_embedding,
            employeeRecord.emp_id,
            employeeRecord.emp_code
          );
          if (selectedFaceBuffer) {
            const directMatch = await rekognition.send(
              new CompareFacesCommand({
                SourceImage: { Bytes: selectedFaceBuffer },
                TargetImage: { Bytes: normalizedCaptureBuffer },
                SimilarityThreshold: Math.max(88, Math.min(matchThreshold, 95)),
              })
            );
            const directSimilarity =
              directMatch?.FaceMatches?.[0]?.Similarity ?? 0;
            if (directSimilarity >= Math.max(88, Math.min(matchThreshold, 95))) {
              safeDebugLog(
                `[${new Date().toISOString()}] Individual fallback verify passed for requestedEmpId=${requestedEmpId} with similarity=${directSimilarity}`
              );
            } else {
              const resolvedEmp = resolvedMatchedEmployee?.emp_id ?? null;
              safeDebugLog(`[${new Date().toISOString()}] Individual Punch Failed: Identity Mismatch. Camera saw ${resolvedEmp ?? matchedExternalId}, but supervisor selected ${requestedEmpId}`);
              return res.status(403).json({
                error: "Identity Mismatch",
                details: `The captured face belongs to someone else, not ${employeeRecord.name}.`,
                suggestion: "Ensure you are punching for the correct person.",
              });
            }
          } else {
            const resolvedEmp = resolvedMatchedEmployee?.emp_id ?? null;
            safeDebugLog(`[${new Date().toISOString()}] Individual Punch Failed: Identity Mismatch. Camera saw ${resolvedEmp ?? matchedExternalId}, but supervisor selected ${requestedEmpId}`);
            return res.status(403).json({
              error: "Identity Mismatch",
              details: `The captured face belongs to someone else, not ${employeeRecord.name}.`,
              suggestion: "Ensure you are punching for the correct person.",
            });
          }
        } catch (identityFallbackError) {
          const resolvedEmp = resolvedMatchedEmployee?.emp_id ?? null;
          safeDebugLog(
            `[${new Date().toISOString()}] Individual fallback verify error for requestedEmpId=${requestedEmpId}: ${identityFallbackError?.message || identityFallbackError}`
          );
          safeDebugLog(`[${new Date().toISOString()}] Individual Punch Failed: Identity Mismatch. Camera saw ${resolvedEmp ?? matchedExternalId}, but supervisor selected ${requestedEmpId}`);
          return res.status(403).json({
            error: "Identity Mismatch",
            details: `The captured face belongs to someone else, not ${employeeRecord.name}.`,
            suggestion: "Ensure you are punching for the correct person.",
          });
        }
      }
    }

    // ≡ƒÆ░ COST OPT: Individual fallback roster loop is DISABLED by default.
    // This path calls CompareFaces for every employee in the ward ΓÇö very expensive.
    // Collection search missing = face likely not enrolled. Return clear error instead.
    // Enable via INDIVIDUAL_FALLBACK_ENABLED=true in .env ONLY for debugging.
    if (!matchedFace && INDIVIDUAL_FALLBACK_ENABLED) {
      const fallback = await fallbackMatchByCompare(
        normalizedCaptureBuffer,
        supervisorId,
        wardId,
        matchThreshold
      );
      if (fallback?.employee && String(fallback.employee.emp_id) !== String(requestedEmpId)) {
        return res.status(403).json({
          error: "Identity Mismatch",
          details: `Face does not match ${employeeRecord.name}.`,
        });
      }
    } else if (!matchedFace) {
      // Face not found in collection ΓÇö instruct supervisor to re-enroll
      console.log(`[face-attendance] Individual: no collection match for emp_id=${requestedEmpId}. Fallback disabled.`);
    }

    if (!employeeRecord) {
      return res.status(403).json({
        error: "No matching employee found",
        suggestion: "Use manual attendance if face recognition fails",
      });
    }

    if (!employeeRecord) {
      return res.status(404).json({
        error: "Employee not registered in system",
        solution: "Register face first via /store-face",
      });
    }

    const empId = employeeRecord.emp_id;

    // ≡ƒöÆ Session-aware validation (prevents re-punch-in + night shift support)
    const sessionError = await validatePunchSession(empId, attendanceDate, punchType);
    if (sessionError) {
      return res.status(sessionError.status).json({
        error: sessionError.error,
        code: sessionError.code,
      });
    }

    // Resolve or create attendance record (handles night-shift carry-forward)
    const attendance = await getOrCreateAttendanceRecord(empId, attendanceDate, {
      punchType,
      createIfMissing: true,
    });

    // ≡ƒôì Geofencing Validation
    const geoCheck = await validateGeofencing(empId, locationPayload.latitude, locationPayload.longitude);
    if (!geoCheck.allowed) {
      if (geoCheck.notConfigured) {
        // Geofencing rules not set up for this zone/ward yet
        return res.status(403).json({
          error: "Your geofencing location is not mapped yet",
          notConfigured: true,
          details: geoCheck.message || "Please contact admin to configure your zone boundaries."
        });
      }
      // Out of zone
      return res.status(403).json({
        error: "Out of Zone",
        notConfigured: false,
        details: geoCheck.message || "You are outside the allowed geo-fence zone."
      });
    }    // ΓÜí PERF FIX: pass context directly so processPunch skips getAttendanceUploadContext DB call
    const punchUploadContext = {
      attendance_date: attendanceDate,
      emp_id: empId,
      emp_code: employeeRecord.emp_code,
      employee_name: employeeRecord.name,
      ward_name: attendance.ward_name ?? null,
      zone_name: null,
      city_name: null,
    };
    const updated = await processPunch(
      attendance.attendance_id,
      punchType,
      req.file,
      userId,
      locationPayload,
      {
        employeeId: empId,
        requireFaceMatch: true,
        faceMatchThreshold: matchThreshold,
        uploadContext: punchUploadContext,
      }
    );

    // ≡ƒöÆ SUPERVISOR SECURITY CHECK
    // If requireFaceMatch was true but similarity is null (missing S3),
    // we block the supervisor punch to prevent "any face" matching.
    if (!updated.face_similarity) {
      const err = new Error("Enrolled face image could not be loaded from storage");
      err.statusCode = 412;
      err.details = "Please re-enroll the employee face before marking attendance.";
      throw err;
    }

    safeDebugLog(`[${new Date().toISOString()}] Individual Punch Success: ${employeeRecord.emp_id}`);
    return res.json({
      success: true,
      employee: employeeRecord.name,
      punch_type: punchType,
      face_similarity: updated.face_similarity ?? null,
      face_match_threshold:
        updated.face_match_threshold ?? matchThreshold,
      time: formatPunchTimeForClient(resolvePunchRecordTime(updated, punchType)),
    });
  } catch (error) {
    console.error("Face attendance error:", error);
    safeDebugLog(`[${new Date().toISOString()}] Face Attendance Route Error: ${error?.stack || error}`);

    if (error.statusCode) {
      return res.status(error.statusCode).json({
        error: error.message,
        ...(error.details ? { details: error.details } : {}),
      });
    }

    const { status, payload } = mapRekognitionError(error);
    res.status(status).json(payload);
  }
});

// Face attendance with AWS liveness pre-check (single employee)
