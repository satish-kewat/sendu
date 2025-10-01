const express = require('express');

const bodyParser = require('body-parser');

const path = require('path');

const multer = require('multer');

const app = express();
app.use(express.static(path.join(__dirname, "public/uploads")))

app.use(bodyParser.urlencoded({extended:false}));

app.use(bodyParser.json());

//Disk Storage
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, 'public/uploads');
  },
  filename: function (req, file, cb) {
    cb(
        null,
        file.fieldname + "-" + Date.now() + path.extname(file.originalname)
    );
  }
});

let upload = multer({storage:storage}).single('file');


//view engine ejs
app.set('view engine', 'ejs');

//open homepage
app.get('/',(req,res)=>{
    res.render('index');
});

app.post('/uploadfile',(req,res)=>{
    upload(req,res,(err)=>{
        if(err){
            console.log(err)
        }else{
            console.log(req.file.path);
            res.json({
                path:req.file.path
            })
        }
    })
})



const PORT = process.env.PORT||5000

app.listen(PORT, ()=>{
    console.log("app is lissting")
})