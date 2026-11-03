import com.fasterxml.jackson.core.json.JsonReadFeature;
import com.fasterxml.jackson.databind.*;
import com.sun.net.httpserver.*;
import io.anserini.search.SimpleSearcher;
import io.anserini.search.ScoredDoc;
import java.io.*;
import java.net.*;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.*;

/** Independent read-only Anserini service. Passage indexes contain no duplicate raw text. */
public class SearchService {
  static final ObjectMapper JSON=new ObjectMapper().enable(JsonReadFeature.ALLOW_UNESCAPED_CONTROL_CHARS.mappedFeature());
  static void send(HttpExchange x,int status,Object body) throws IOException {
    byte[] bytes=JSON.writeValueAsBytes(body);x.getResponseHeaders().set("Content-Type","application/json");
    x.sendResponseHeaders(status,bytes.length);try(OutputStream out=x.getResponseBody()){out.write(bytes);}
  }
  public static void main(String[] args) throws Exception {
    if(args.length!=7) throw new IllegalArgumentException("INDEX HOST PORT MODE EXPECTED_DOCS K1 B");
    String mode=args[3];int expected=Integer.parseInt(args[4]);
    SimpleSearcher engine=new SimpleSearcher(args[0]);
    engine.set_bm25(Float.parseFloat(args[5]),Float.parseFloat(args[6]));
    if(engine.get_total_num_docs()!=expected) throw new IllegalStateException("Index count mismatch");
    engine.search("warmup",1);
    HttpServer server=HttpServer.create(new InetSocketAddress(args[1],Integer.parseInt(args[2])),16);
    server.setExecutor(Executors.newFixedThreadPool(4));
    server.createContext("/health",x->{
      send(x,200,Map.of("ready",true,"mode",mode,"documents",expected,"bm25",Map.of("k1",Double.parseDouble(args[5]),"b",Double.parseDouble(args[6])),"index",Path.of(args[0]).getFileName().toString()));
    });
    server.createContext("/search",x->{
      try {
        if(!x.getRequestMethod().equals("POST")) {send(x,405,Map.of("error","POST required"));return;}
        byte[] bytes=x.getRequestBody().readNBytes(65537);if(bytes.length>65536) throw new IllegalArgumentException("request too large");
        JsonNode body=JSON.readTree(bytes);String query=body.path("query").asText();int k=body.path("k").asInt(1000);
        if(query.isBlank()||query.length()>10000||k<1||k>1000) throw new IllegalArgumentException("query/k bounds");
        long start=System.nanoTime();List<Object> hits=new ArrayList<>();
        for(ScoredDoc hit:engine.search(query,k)) {
          Map<String,Object> row=new LinkedHashMap<>();row.put("docid",hit.docid);row.put("score",hit.score);
          if(mode.equals("document")) {
            String raw=engine.doc_raw(hit.docid);
            if(raw==null) throw new IllegalStateException("Missing full-document source");
            String text=JSON.readTree(raw).get("text").asText();row.put("length_utf16",text.length());
          }
          hits.add(row);
        }
        send(x,200,Map.of("results",hits,"elapsed_ms",(System.nanoTime()-start)/1e6));
      } catch(Exception e) {send(x,500,Map.of("error",e.getClass().getSimpleName()+": "+e.getMessage()));}
    });
    server.createContext("/doc",x->{
      try {
        if(!mode.equals("document")) {send(x,404,Map.of("error","Passage raw text is reconstructed from immutable parents"));return;}
        JsonNode body=JSON.readTree(x.getRequestBody().readNBytes(65536));String id=body.path("docid").asText();
        if(!id.matches("shard_[0-9]{5}_[0-9]+")) throw new IllegalArgumentException("invalid parent id");
        String raw=engine.doc_raw(id);
        if(raw==null){send(x,404,Map.of("found",false,"docid",id));return;}
        String text=JSON.readTree(raw).get("text").asText();
        send(x,200,Map.of("found",true,"docid",id,"text",text,"length_utf16",text.length()));
      } catch(Exception e) {send(x,500,Map.of("error",e.getClass().getSimpleName()+": "+e.getMessage()));}
    });
    server.createContext("/lengths",x->{
      try {
        if(!mode.equals("document")) {send(x,404,Map.of("error","document mode required"));return;}
        JsonNode body=JSON.readTree(x.getRequestBody().readNBytes(131072));JsonNode ids=body.path("docids");
        if(!ids.isArray()||ids.size()>2000) throw new IllegalArgumentException("docids bounds");
        Map<String,Integer> lengths=new LinkedHashMap<>();
        for(JsonNode item:ids) {
          String id=item.asText();if(!id.matches("shard_[0-9]{5}_[0-9]+")) throw new IllegalArgumentException("invalid parent id");
          String raw=engine.doc_raw(id);if(raw==null) throw new IllegalStateException("Missing parent "+id);
          lengths.put(id,JSON.readTree(raw).get("text").asText().length());
        }
        send(x,200,Map.of("lengths",lengths));
      } catch(Exception e) {send(x,500,Map.of("error",e.getClass().getSimpleName()+": "+e.getMessage()));}
    });
    Runtime.getRuntime().addShutdownHook(new Thread(()->{server.stop(1);try{engine.close();}catch(IOException ignored){}}));
    server.start();System.out.println(JSON.writeValueAsString(Map.of("type","server_ready","mode",mode,"port",server.getAddress().getPort(),"documents",expected)));
  }
}
