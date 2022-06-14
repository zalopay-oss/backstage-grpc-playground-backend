export interface Config {
  grpcPlayground?: {
    document?: {
      /**
       * @visibility frontend
       */
      enabled?: boolean;

      /**
       * Install protoc-gen-doc from github
       */
      protocGenDoc?: {
        install?: boolean;
        version?: string;
      }
    };
  };
}