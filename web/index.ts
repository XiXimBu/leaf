// Dung de tao ung dung Express va lay kieu Express cho bien app.
import express, { Express } from "express";
import "dotenv/config";
import path from "path";
// import cookieParser from "cookie-parser";
// import cors from "cors";
// Dung de gan toan bo router phien ban v1 vao app chinh.
import Routes from "./routes/index.routes";

// Dung module database de mo ket noi MongoDB truoc khi app nhan request.
import * as database from "./config/database";
// import path from "path/win32";
  

// app duoc gan kieu Express de TypeScript biet day la doi tuong server cua Express.
const app: Express = express();
app.use(express.static("public"));
app.use(
    "/vendor/chart.js",
    express.static(path.join(__dirname, "node_modules", "chart.js", "dist"))
);
app.set('views', './views');
app.set('view engine', 'pug');
// number | string la union type: port co the la so 3000 hoac chuoi lay tu bien moi truong.
const port: number | string = process.env.PORT || 3000;

// Note: Su dung express.json() theo yeu cau de parse JSON body.
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
// Note: cookie-parser giup doc duoc req.cookies trong auth middleware/controller.
// app.use(cookieParser());

const corsOrigin = process.env.CORS_ORIGIN || "http://localhost:3000";
// app.use(
//     cors({
//         origin: corsOrigin,
//         credentials: true,
//     })
// );
// Goi ham ket noi database ngay khi app khoi dong.
database.connect();

Routes(app);

// Note: Error handling co ban, tra ve JSON thong nhat khi co loi.
app.use((error: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
    const statusCode = (error as Error & { statusCode?: number }).statusCode || 500;
    if (res.headersSent) {
        next(error);
        return;
    }
    res.status(statusCode).json({
        success: false,
        message: error.message || "Internal server error",
    });
});

// app.listen la API cua Node/Express de mo cong va lang nghe request.
app.listen(port, () => {
    console.log(`App is listening on port ${port}`);
});