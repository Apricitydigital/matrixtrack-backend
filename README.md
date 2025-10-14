# 🚀 Attendease Backend (Node.js + Express.js)

This is the backend server for **Attendease**, handling authentication, face recognition, attendance logging, and database operations.

## **📌 Features**

✅ **JWT Authentication** (Admin/Supervisor)  
✅ **Face Recognition API** (AWS Rekognition Integration)  
✅ **Attendance Logging** (Auto + Manual Modes)  
✅ **Geocoding** (GPS → Address Conversion)  
✅ **PostgreSQL Database** (Structured employee/attendance data)

## **⚙️ Tech Stack**

- **Runtime:** Node.js
- **Framework:** Express.js
- **Database:** PostgreSQL (AWS RDS)
- **Face Recognition:** AWS Rekognition
- **Storage:** AWS S3 (Face Images)
- **Auth:** JWT + Bcrypt Hashing

## **🔧 Setup Instructions**

### **1. Prerequisites**

- Node.js `v16+`
- PostgreSQL `v12+`
- AWS Account (Rekognition, S3, RDS)

### **2. Installation**

```bash
# Clone repo
git clone [backend-repo-url]
cd attendease-backend

# Install dependencies
npm install

# Set up environment variables (create `.env` file)
cp .env.example .env
```

### **3. Sample .env file**

```bash
# DataBase
DB_USER=
DB_PASSWORD=
DB_HOST=
DB_NAME=
DB_PORT=5432

JWT_SECRET=
NODE_ENV=production

# AWS S3
AWS_ACCESS_KEY=
AWS_SECRET_ACCESS_KEY=
AWS_REGION=
AWS_S3_BUCKET=

REKOGNITION_COLLECTION=
```
