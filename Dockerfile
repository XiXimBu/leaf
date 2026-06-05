# Chọn môi trường cơ sở (Ví dụ: Bạn cần máy có cài sẵn Python, Node.js hay PHP?).
# Sử dụng Node.js bản 20 do dự án chạy bằng Node.js và TypeScript.
FROM node:20

# Tạo một thư mục làm việc bên trong cái hộp (Container).
WORKDIR /app

# Copy toàn bộ mã nguồn từ máy tính của bạn bỏ vào cái hộp đó.
COPY . .

# Chạy lệnh cài đặt các thư viện/phụ thuộc mà dự án của bạn cần (Ví dụ: npm install hoặc pip install).
# Project nằm trong thư mục web, nên cần cd vào web để npm install.
RUN cd web && npm install

# Nếu hệ thống có sử dụng các script Python bên ngoài (như video_tracking_stream.py),
# bạn có thể cần cài thêm Python và các thư viện cần thiết bằng lệnh:
# RUN apt-get update && apt-get install -y python3 python3-pip && pip3 install -r requirements.txt --break-system-packages


EXPOSE 3000

CMD ["npm", "start", "--prefix", "web"]
