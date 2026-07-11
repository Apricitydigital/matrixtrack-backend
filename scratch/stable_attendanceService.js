/**
 * Attendance Service for AttendEase Mobile App
 * Handles attendance-related operations with location and camera integration
 */

import * as Location from 'expo-location';
import * as ImagePicker from 'expo-image-picker';
import { apiService } from './apiService';

const RECENT_LOCATION_WINDOW_MS = 2 * 60 * 1000;

export class AttendanceService {
  constructor() {
    this.currentLocation = null;
  }

  // ≡ƒôì Location Services
  async requestLocationPermission() {
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        throw new Error('Location permission not granted');
      }
      return true;
    } catch (error) {
      console.error('Location permission error:', error);
      return false;
    }
  }

  async getCurrentLocation(options = {}) {
    const {
      requireFresh = false,
      maxAgeMs = RECENT_LOCATION_WINDOW_MS,
      accuracy = 'balanced',
      includeAddress = false,
    } = options;

    try {
      const now = Date.now();
      if (
        !requireFresh &&
        this.currentLocation &&
        this.currentLocation.timestamp &&
        now - this.currentLocation.timestamp <= maxAgeMs
      ) {
        if (includeAddress && !this.currentLocation.address) {
          await this.ensureAddress(this.currentLocation);
        }
        return { ...this.currentLocation };
      }

      const hasPermission = await this.requestLocationPermission();
      if (!hasPermission) {
        throw new Error('Location permission required');
      }

      const desiredAccuracy =
        accuracy === 'high'
          ? Location.Accuracy.Highest
          : accuracy === 'low'
            ? Location.Accuracy.Low
            : Location.Accuracy.Balanced;

      const position = await Location.getCurrentPositionAsync({
        accuracy: desiredAccuracy,
      });

      if (position.mocked) {
        throw new Error('Spoofed Location Detected', { cause: 'MOCKED_LOCATION' });
      }

      const sampledLocation = {
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
        accuracy: position.coords.accuracy,
        timestamp: now,
        address: null,
      };

      this.currentLocation = sampledLocation;

      if (includeAddress) {
        sampledLocation.address = await this.getAddressFromCoordinates(
          sampledLocation.latitude,
          sampledLocation.longitude
        );
        this.currentLocation.address = sampledLocation.address;
      }

      return { ...sampledLocation };
    } catch (error) {
      console.error('Get location error:', error);
      throw error;
    }
  }

  async getAddressFromCoordinates(latitude, longitude) {
    try {
      const addresses = await Location.reverseGeocodeAsync({
        latitude,
        longitude,
      });

      if (addresses.length > 0) {
        const address = addresses[0];
        const parts = [
          address.name,
          address.streetNumber,
          address.street,
          address.district,
          address.subregion,
          address.city,
          address.region,
          address.postalCode,
        ].filter((p) => p && typeof p === 'string' && p.trim().length > 0);

        if (parts.length > 0) {
          return parts.join(', ');
        }
      }
      return `${latitude}, ${longitude}`;
    } catch (error) {
      console.error('Reverse geocoding error:', error);
      return `${latitude}, ${longitude}`;
    }
  }

  locationsMatch(a, b) {
    if (!a || !b) {
      return false;
    }
    return (
      Math.abs(a.latitude - b.latitude) < 0.00001 &&
      Math.abs(a.longitude - b.longitude) < 0.00001
    );
  }

  async ensureAddress(location) {
    if (!location || location.address) {
      return location?.address ?? null;
    }

    const address = await this.getAddressFromCoordinates(location.latitude, location.longitude);
    if (address) {
      location.address = address;
      if (this.locationsMatch(this.currentLocation, location)) {
        this.currentLocation.address = address;
      }
    }
    return address;
  }

  // ≡ƒô╖ Camera Services
  async requestCameraPermission() {
    try {
      const { status } = await ImagePicker.requestCameraPermissionsAsync();
      if (status !== 'granted') {
        throw new Error('Camera permission not granted');
      }
      return true;
    } catch (error) {
      console.error('Camera permission error:', error);
      return false;
    }
  }

  async capturePhoto(options = {}) {
    try {
      const hasPermission = await this.requestCameraPermission();
      if (!hasPermission) {
        throw new Error('Camera permission required');
      }

      const result = await ImagePicker.launchCameraAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        allowsEditing: true,
        aspect: [1, 1],
        quality: 0.8,
        ...options,
      });

      if (!result.canceled && result.assets[0]) {
        return result.assets[0];
      }
      return null;
    } catch (error) {
      console.error('Capture photo error:', error);
      throw error;
    }
  }

  // ≡ƒæ╖ Attendance Operations
  async punchIn(userId, attendanceId = null) {
    try {
      // Get current location
      const locationData = await this.getCurrentLocation({
        accuracy: 'balanced',
        maxAgeMs: RECENT_LOCATION_WINDOW_MS,
        includeAddress: true,
      });

      // Capture photo
      const photo = await this.capturePhoto();
      if (!photo) {
        throw new Error('Photo is required for punch in');
      }

      // Prepare form data
      const formData = new FormData();
      if (attendanceId) formData.append('attendance_id', attendanceId);
      formData.append('punch_type', 'IN');
      formData.append('latitude', locationData.latitude.toString());
      formData.append('longitude', locationData.longitude.toString());
      formData.append('address', locationData.address || '');
      formData.append('userId', userId.toString());

      // Add image
      formData.append('image', {
        uri: photo.uri,
        type: 'image/jpeg',
        name: 'punch_in.jpg',
      });

      // Submit to API
      const response = await apiService.punchInOut(formData);
      await this.ensureAddress(locationData).catch(() => null);

      return {
        success: true,
        data: response.data,
        location: locationData,
        photo: photo.uri,
      };
    } catch (error) {
      console.error('Punch in error:', error);
      throw error;
    }
  }

  async punchOut(userId, attendanceId) {
    try {
      // Get current location
      const locationData = await this.getCurrentLocation({
        accuracy: 'balanced',
        maxAgeMs: RECENT_LOCATION_WINDOW_MS,
        includeAddress: true,
      });

      // Capture photo
      const photo = await this.capturePhoto();
      if (!photo) {
        throw new Error('Photo is required for punch out');
      }

      // Prepare form data
      const formData = new FormData();
      formData.append('attendance_id', attendanceId);
      formData.append('punch_type', 'OUT');
      formData.append('latitude', locationData.latitude.toString());
      formData.append('longitude', locationData.longitude.toString());
      formData.append('address', locationData.address || '');
      formData.append('userId', userId.toString());

      // Add image
      formData.append('image', {
        uri: photo.uri,
        type: 'image/jpeg',
        name: 'punch_out.jpg',
      });

      // Submit to API
      const response = await apiService.punchInOut(formData);
      await this.ensureAddress(locationData).catch(() => null);

      return {
        success: true,
        data: response.data,
        location: locationData,
        photo: photo.uri,
      };
    } catch (error) {
      console.error('Punch out error:', error);
      throw error;
    }
  }

  // ≡ƒû╝ Face Recognition Attendance
  async faceAttendance(userId, punchType = 'in', options = {}) {
    try {
      const { selfService = false, empId = null, timeout } = options;
      // Get current location
      const locationData = await this.getCurrentLocation({
        accuracy: 'balanced',
        maxAgeMs: RECENT_LOCATION_WINDOW_MS,
        includeAddress: true,
      });

      // Capture face photo
      const photo = await this.capturePhoto({
        allowsEditing: false, // Don't allow editing for face recognition
        aspect: [1, 1],
        quality: 0.9, // Higher quality for face recognition
      });

      if (!photo) {
        throw new Error('Face photo is required');
      }

      // Prepare form data
      const formData = new FormData();
      formData.append('punch_type', punchType?.toUpperCase?.() ?? 'IN');
      formData.append('latitude', locationData.latitude.toString());
      formData.append('longitude', locationData.longitude.toString());
      formData.append('address', locationData.address || '');
      formData.append('userId', userId.toString());
      if (empId) {
        formData.append('emp_id', empId.toString());
      }
      
      // Add face image
      formData.append('image', {
        uri: photo.uri,
        type: 'image/jpeg',
        name: 'face_attendance.jpg',
      });

      // Submit to API
      const response = selfService
        ? await apiService.selfFacePunch(formData, { timeout })
        : await apiService.faceAttendance(formData, { timeout });
      await this.ensureAddress(locationData).catch(() => null);

      return {
        success: true,
        data: response.data,
        location: locationData,
        photo: photo.uri,
      };
    } catch (error) {
      console.error('Face attendance error:', error);
      throw error;
    }
  }

  async storeFaceData(userId, employeeId = null) {
    try {
      // Capture face photo for enrollment
      const photo = await this.capturePhoto({
        allowsEditing: false,
        aspect: [1, 1],
        quality: 0.9,
      });

      if (!photo) {
        throw new Error('Face photo is required for enrollment');
      }

      // Prepare form data
      const formData = new FormData();
      formData.append('userId', userId.toString());
      if (employeeId) {
        formData.append('emp_id', employeeId.toString());
      }

      // Add face image
      formData.append('image', {
        uri: photo.uri,
        type: 'image/jpeg',
        name: 'face_enrollment.jpg',
      });

      // Submit to API
      const response = await apiService.storeFace(formData);
      return {
        success: true,
        data: response.data,
        photo: photo.uri,
      };
    } catch (error) {
      console.error('Store face error:', error);
      throw error;
    }
  }

  // ≡ƒôè Data Retrieval
  async getEmployeeAttendance(empId, wardId, date) {
    try {
      const response = await apiService.getEmployeeAttendance(empId, wardId, date);
      return response.data;
    } catch (error) {
      console.error('Get employee attendance error:', error);
      throw error;
    }
  }

  async getEmployeeDetail(empId, month) {
    try {
      const response = await apiService.getEmployeeDetail(empId, month);
      return response.data;
    } catch (error) {
      console.error('Get employee detail error:', error);
      throw error;
    }
  }

  async getAttendanceImage(attendanceId, punchType) {
    try {
      const response = await apiService.fetchImage(attendanceId, punchType);
      return response.data;
    } catch (error) {
      console.error('Get attendance image error:', error);
      throw error;
    }
  }
}

export default new AttendanceService();
